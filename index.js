'use strict';

const http = require('http');
const urllib = require('url');

let Accessory, Service, Characteristic, UUIDGen;

const PLUGIN_NAME = "homebridge-shelly-switch";
const PLATFORM_NAME = "Shelly Switch";

module.exports = function (api) {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    UUIDGen = api.hap.uuid;
    api.registerPlatform(PLATFORM_NAME, ShellySwitch);
};

class ShellySwitch {
    constructor(log, config, api) {
        this.api = api;
        this.accessories = [];

        this.services = new Map();
        this.log = log;
        this.devices = config.devices;
        this.indexes = new Map();
        this.current_status = new Map();
        this.status_callbacks = new Map();
        this.current_status_time = new Map();
        this.status_timer = new Map();
        this.notification_port = config.notification_port || null;


        this.devices.forEach ((el) => {
            if (!el.ip) {
                throw new Error('You must provide an ip address of the switch.');
            }
        });

        api.on('didFinishLaunching', () => {
            if (this.notification_port) {
                this.log.debug(`Starting status notification server at port ${this.notification_port}`);
                this.notification_server = http.createServer((req, res) => {
                    this.serverHandler(req, res);
                });
                this.notification_server.listen(this.notification_port, () => {
                    this.log.debug(`Started status notification server at port ${this.notification_port}`);
                });
            }
    
            // Set up switches

            this.devices.forEach((el, i, arr) => {
                const key = 'switch' + i;
                const uuid = this.api.hap.uuid.generate(`homebridge-shelly-switch:platform:accessory:${key}`);

                let accessory = this.accessories.find(accessory => accessory.UUID == uuid);
                let switchService;
                let infoService;

                if (!accessory) {
                    accessory = new this.api.platformAccessory(el.name, uuid);
                    switchService = new api.hap.Service.Switch();
                    accessory.addService(switchService);

                    infoService = new Service.AccessoryInformation();
                    accessory.addService(infoService);

                    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                } else {
                    switchService = accessory.getService(Service.Switch);
                    infoService = accessory.getService(Service.AccessoryInformation);
                }

                switchService.getCharacteristic(Characteristic.On)
                    .on('get', (callback) => { this.getSwitchStatus(key, el, callback) } )
                    .on('set', (value, callback) => { this.setSwitchStatus(key, el, value, callback) } );

                switchService.getCharacteristic(Characteristic.Name)
                    .on('get', (callback) => { callback(el.name) } )

                infoService
                    .setCharacteristic(Characteristic.Manufacturer, 'Allterco Robotics Ltd.')
                    .setCharacteristic(Characteristic.Model, 'Shelly 1');

                this.services.set(key, switchService);
                this.indexes.set(key, i);

            });
        });

        this.updateStatus(true);
    }

    serverHandler(req, res) {
        if (req.url.startsWith('/status')) {
            this.log.debug(`Status update notification received from ${req.socket.remoteAddress}`);
            // find the device
            let remoteAddress = req.socket.remoteAddress;

            let found = false;

            this.indexes.forEach((index, id) => {
                if (found) { return; }

                this.log.debug(`checking index ${id}, ${index}`);

                if (remoteAddress.indexOf(this.devices[index].ip) != -1) {
                    this.updateStatus(true, id);

                    res.writeHead(200);
                    res.end('OK');
                    found = true;
                }
            });

            if (!found) {
                res.writeHead(404);
                res.end('Not Found');
            }

            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    }

    configureAccessory(accessory) {
        this.accessories.push(accessory);
    }

    /*getServices() {
        return [...this.services.values()];
    }*/

    setSwitchStatus(id, device, status, callback) {
        var log = this.log;
        log.debug(`Setting status of device ${device.ip} to '${status}'`);

        const url = 'http://' + device.ip + `/relay/0/?turn=${status ? "on" : "off"}`;
        log.debug(`url: ${url}`);
        this.sendJSONRequest({url: url, method: 'POST'})
            .then((response) => {
                this.current_status.set(id, response);
                this.current_status_time.set(id, Date.now());

                callback();
                this.updateStatus(false, id);
            })
            .catch((e) => {
                log.error(`Failed to change switch status: ${e}`);
                setTimeout(() => { callback(e); this.updateStatus(true, id); }, 3000);
            });
    }

    getSwitchStatus(id, device, callback) {
        this.getStatus(id, false, (error) => {
            if (error) {
                callback(error);
                return;
            }
            
            let isOn = this.current_status.get(id).ison == true;

            callback(null, isOn);
        });
    }

    updateStatus(forced = false, id = null) {
        this.log.debug(`Updating switch status of ${id}`);

        let identifiers;

        if (!id) {
            identifiers = [ ...this.indexes.keys()];
        } else {
            identifiers = [id];
        }

        identifiers.forEach((id) => {

            this.getStatus(id, forced, (err) => {
                if (err) {
                    return;
                }
    
                let status = this.current_status.get(id);
                let isOn = status.ison == true;
                this.log.debug(`Reported current state for ${id}: ${isOn}`);
                this.services.get(id).updateCharacteristic(Characteristic.On, isOn);
            });
        });
    }

    updateInterval() {
        return 30000;
    }

    clearUpdateTimer(id) {
        if (this.status_timer.has(id)) {
            clearTimeout(this.status_timer.get(id));
        }
    }

    setupUpdateTimer(id) {
        if (this.notification_server) { // don't schedule status updates for polling - we have them pushed by the switch
          return;
        }

        this.clearUpdateTimer(id);
        this.status_timer.set(
            id, 
            setTimeout(() => { this.updateStatus(true, id); }, this.updateInterval()));
    }

    needsUpdate() {
        return true;
    };

    getStatus(id, forced, callback) {
        let identifiers;
        if (!id) {
            identifiers = [ ...this.indexes.keys()];
        } else {
            identifiers = [id];
        }

        identifiers.forEach((id) => {
            if (!this.status_callbacks.has(id)) {
                this.status_callbacks.set(id, []);
            }
    
            if (this.status_callbacks.get(id).length > 0) {
                this.log.debug('Pushing status callback to queue - updating');
                this.status_callbacks.get(id).push(callback);
                return;
            }
    
            const now = Date.now();
    
            if (!forced && this.current_status.has(id) &&
                this.current_status_time.has(id) &&
                (now - this.current_status_time.get(id) < this.updateInterval())) {
                this.log.debug('Returning cached status');
                callback(null);
                return;
            }
    
            this.clearUpdateTimer(id);
    
            this.status_callbacks.get(id).push(callback);

            const device = this.devices[this.indexes.get(id)];
    
            this.sendJSONRequest({url: 'http://' + device.ip + '/relay/0', authentication: device.authentication})
                .then((response) => {
                    this.current_status.set(id, response);
                    this.current_status_time.set(id, Date.now());
                    const callbacks = this.status_callbacks.get(id);
                    this.status_callbacks.set(id, []);
    
                    this.log.debug(`Calling ${callbacks.length} queued callbacks`);
                    callbacks.forEach((element) => {
                        element(null, response);
                    });
                    this.setupUpdateTimer(id);
                })
                .catch((e) => {
                    this.log.error(`Error parsing current status info: ${e}`);
                    const callbacks = this.status_callbacks.get(id);
                    this.status_callbacks.set(id, []);
    
                    callbacks.forEach((element) => {
                        element(e);
                    });
    
                    this.setupUpdateTimer(id);
                });
    
        });


    }

    sendJSONRequest(params) {
        return new Promise((resolve, reject) => {

            if (!params.url) {
                reject(Error('Request URL missing'));
            }

            const components = new urllib.URL(params.url);

            const options = {
                method: params.method || 'GET',
                host: components.hostname,
                port: components.port,
                path: components.pathname + (components.search ? components.search : ''),
                protocol: components.protocol,
                headers: { 'Content-Type': 'application/json' }
            };

            if (params.authentication) {
                let credentials = Buffer.from(params.authentication).toString('base64');
                options.headers['Authorization'] = 'Basic ' + credentials;
            }

            const req = http.request(options, (res) => {
                res.setEncoding('utf8');

                let chunks = '';
                res.on('data', (chunk) => { chunks += chunk; });
                res.on('end', () => {
                    try {
                        this.log.debug(`Raw response: ${chunks}`);
                        const parsed = JSON.parse(chunks);
                        resolve(parsed);
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            req.on('error', (err) => {
                reject(err);
            });

            if (params.payload) {
                const stringified = JSON.stringify(params.payload);
                this.log(`sending payload: ${stringified}`);
                req.write(stringified);
            }

            req.end();
        });
    }
}
