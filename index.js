'use strict';

const http = require('http');
const urllib = require('url');

let Accessory, Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
    Accessory = homebridge.platformAccessory;
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;
    homebridge.registerAccessory('homebridge-shelly-switch', 'shelly-switch', ShellySwitch);
};

class ShellySwitch {
    constructor(log, config) {
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

        if (this.notification_port) {
            this.log.debug(`Starting status notification server at port ${this.notification_port}`);
            this.notification_server = http.createServer((req, res) => {
                this.serverHandler(req, res);
            });
            this.notification_server.listen(this.notification_port, () => {
                this.log.debug(`Started status notification server at port ${this.notification_port}`);
            });
        }

        this.serviceInfo = new Service.AccessoryInformation();
        this.serviceInfo
            .setCharacteristic(Characteristic.Manufacturer, 'Allterco Robotics Ltd.')
            .setCharacteristic(Characteristic.Model, 'Shelly 1');
        this.services.set('info', this.serviceInfo);

        this.devices.forEach((el, i, arr) => {
            const key = 'switch' + i;
            let switchService = new Service.Switch(el.name, key);
            switchService.getCharacteristic(Characteristic.On)
                .on('get', this.getSwitchStatus.bind(this, key, el))
                .on('set', this.setSwitchStatus.bind(this, key, el));
                
            this.services.set(key, switchService);
            this.indexes.set(key, i);
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

    getServices() {
        return [...this.services.values()];
    }

    setSwitchStatus(id, device, status, callback) {
        var log = this.log;
        log.debug(`Setting status of device ${device.ip} to '${status}'`);

        const url = 'http://' + device.ip + `/relay/0/?turn=${status ? "on" : "off"}`;
        log.debug(`url: ${url}`);
        this.sendJSONRequest(url, 'POST')
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
        return 10000;
    }

    clearUpdateTimer() {
        // clearTimeout(this.status_timer);
    }

    setupUpdateTimer() {
        if (this.notification_server) { // don't schedule status updates for polling - we have them pushed by the switch
          return;
        }

        // this.status_timer = setTimeout(() => { this.updateStatus(true); }, this.updateInterval());
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
    
            this.clearUpdateTimer();
    
            this.log.debug(`Executing update, forced: ${forced}`);
    
            this.status_callbacks.get(id).push(callback);
    
            this.sendJSONRequest('http://' + this.devices[this.indexes.get(id)].ip + '/relay/0')
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

    sendJSONRequest(url, method = 'GET', payload = null) {
        return new Promise((resolve, reject) => {

            const components = new urllib.URL(url);

            const options = {
                method: method,
                host: components.hostname,
                port: components.port,
                path: components.pathname + (components.search ? components.search : ''),
                protocol: components.protocol,
                headers: { 'Content-Type': 'application/json' }
            };

            if (this.authentication) {
                let credentials = Buffer.from(this.authentication).toString('base64');
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

            if (payload) {
                const stringified = JSON.stringify(payload);
                this.log(`sending payload: ${stringified}`);
                req.write(stringified);
            }

            req.end();
        });
    }
}
