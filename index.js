'use strict';

const http = require('http');
const urllib = require('url');

let Accessory, Service, Characteristic, UUIDGen;

const PLUGIN_NAME = "homebridge-shelly-switch";
const PLATFORM_NAME = "Shelly Switch";
const DEVICE_TYPE_DIMMER = 'dimmer';
const DEVICE_TYPE_SWITCH = 'switch';

module.exports = function (api) {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    UUIDGen = api.hap.uuid;
    api.registerPlatform(PLATFORM_NAME, ShellySwitch);
};

class ShellySwitch {
    deviceUuid(device) {
        const key = `switch-${device.ip}`;
        const uri = `homebridge-shelly-switch:platform:accessory:${key}`;
        const uuid = this.api.hap.uuid.generate(uri);

        return uuid;
    }

    deviceButtonUuid(device) {
        const key = `switch-${device.ip}-button-0`;
        const uri = `homebridge-shelly-switch:platform:accessory:${key}`;
        const uuid = this.api.hap.uuid.generate(uri);

        return uuid;
    }

    constructor(log, config, api) {
        this.api = api;
        this.accessories = [];

        this.services = new Map();
        this.log = log;
        this.devices = config.devices;
        this.uuids = new Map();
        this.indexes = new Map();
        this.current_status = new Map();
        this.status_callbacks = new Map();
        this.current_status_time = new Map();
        this.status_timer = new Map();
        this.notification_port = config.notification_port || null;
        this.buttonDevices = new Map();

        this.devices.forEach ((el) => {
            if (!el.ip) {
                throw new Error('Address of the switch is missing');
            }

            if (!el.name) {
                throw new Error('Name of the switch is missing');
            }
        });

        this.devices.forEach((el, i) => {
            const uuid = this.deviceUuid(el);
            this.uuids.set(uuid, i);
        });


        this.api.on('didFinishLaunching', () => {
            this.cleanupUnknownDevices();
            this.configureDevices();
            this.configureServer();
        });

        this.updateStatus(true);
    }

    configureServer() {
        if (this.notification_port) {
            this.log.debug(`Starting status notification server at port ${this.notification_port}`);
            this.notification_server = http.createServer((req, res) => {
                this.serverHandler(req, res);
            });
            this.notification_server.listen(this.notification_port, () => {
                this.log.debug(`Started status notification server at port ${this.notification_port}`);
            });
        }
    }

    configureDevices() {
        this.devices.forEach((device, i) => {
            const key = `switch-${device.ip}`;
            const uri = `homebridge-shelly-switch:platform:accessory:${key}`;
            const uuid = this.deviceUuid(device);

            let deviceService;
            let accessory = this.accessories.find(accessory => accessory.UUID == uuid);
            const serviceType = this.isDimmer(device) ? this.api.hap.Service.Lightbulb : this.api.hap.Service.Switch;

            if (!accessory) {
                accessory = new this.api.platformAccessory(device.name, uuid);
                deviceService = new serviceType();
                accessory.addService(deviceService);

                this.log.debug(`Registering switch accessory: ${uuid} for ${device.name} (deviceType:${device.deviceType})`);
                this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
            } else {
                deviceService = accessory.getService(serviceType);
            }

            deviceService.getCharacteristic(Characteristic.On)
                .on('get', (callback) => { this.getSwitchStatus(key, device, callback) } )
                .on('set', (value, callback) => { this.setSwitchStatus(key, device, 0, value, callback) } );

            if (this.isDimmer(device)) {
              deviceService.getCharacteristic(Characteristic.Brightness)
                .on('get', (callback) => {
                  this.getSwitchStatus(key, device, callback);
                })
                .on('set', (value, callback) => {
                  this.log.info('brightness', value);
                  this.setSwitchStatus(key, device, 0, value, callback);
                });
            }

            deviceService.getCharacteristic(Characteristic.Name)
                .on('get', (callback) => { callback(device.name) } );

            this.services.set(key, deviceService);
            this.indexes.set(key, i);

            this.canExposeButton(key, (canExposeButton) => {
                let programmableSwitch = accessory.getService(Service.StatelessProgrammableSwitch);

                if (typeof(canExposeButton) == Error || !canExposeButton) {
                    if (programmableSwitch) {
                        accessory.removeService(programmableSwitch);
                    }
                    return;
                }

                if (!programmableSwitch) {
                    programmableSwitch = new this.api.hap.Service.StatelessProgrammableSwitch(device.name + ' Button');
                    programmableSwitch
                        .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
                        .setProps( { minValue: 0, maxValue: 2, validValues: [0, 2] }); // short and long press

                    accessory.addService(programmableSwitch);
                } else {
                    this.log.debug(`Found programmable switch service of ${programmableSwitch.UUID}`);
                }

                const buttonKey = key + 'button-0';

                this.indexes.set(buttonKey, i);
                this.buttonDevices.set(key, programmableSwitch);

            });
        });
    }

    cleanupUnknownDevices() {
        this.accessories.forEach((el, i) => {

            let device = this.uuids.get(el.UUID);
            if (device === undefined) {
                this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [el]);
            }
        });
    }

    serverHandler(req, res) {
        this.log.debug(`Notification received from ${req.socket.remoteAddress}`);
        // find the device
        let remoteAddress = req.socket.remoteAddress;

        let foundId = null;

        this.indexes.forEach((index, id) => {
            if (foundId) { return; }

            this.log.debug(`checking index ${id}, ${index} for ${remoteAddress}`);

            if (remoteAddress.indexOf(this.devices[index].ip) != -1) {
                foundId = id;
                this.log.debug(`Found device ${id}`);
            }
        });

        if (!foundId) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        if (req.url.endsWith('/status')) {
            this.updateStatus(true, foundId);

            res.writeHead(200);
            res.end('OK');
            return;
        }

        if (req.url.endsWith('/button/0/short')) {

            this.triggerShortPress(foundId, 0);

            res.writeHead(200);
            res.end('OK');
            return;
        }

        if (req.url.endsWith('/button/0/long')) {

            this.triggerLongPress(foundId, 0);

            res.writeHead(200);
            res.end('OK');
            return;
        }

        res.writeHead(404);
        res.end('Not Found');
    }

    configureAccessory(accessory) {
        this.accessories.push(accessory);
    }

    triggerShortPress(id, index) {
        const service = this.buttonDevices.get(id);
        service
            .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
            .setValue(Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);
    }

    triggerLongPress(id) {
        const service = this.buttonDevices.get(id);
        service
            .getCharacteristic(Characteristic.ProgrammableSwitchEvent)
            .setValue(Characteristic.ProgrammableSwitchEvent.LONG_PRESS);
    }

    async setSwitchStatus(id, device, index, status, callback) {
        var log = this.log;
        log.debug(`Setting status of device ${device.ip} to '${status}'`);

        const url = this.getSetStatusUrl(device, index, status);
        log.debug(`url: ${url}`);

        try {
            let response = await this.sendJSONRequest({url: url, method: 'POST', authentication: device.authentication})
            this.current_status.set(id, response);
            this.current_status_time.set(id, Date.now());

            callback();
            this.updateStatus(false, id);
        } catch (e) {
            log.error(`Failed to change switch status: ${e}`);
            setTimeout(() => { callback(e); this.updateStatus(true, id); }, 3000);
        }
    }

    getSetStatusUrl(device, index, status) {
        const turn = `turn=${status ? 'on' : 'off'}`;
        if (this.isDimmer(device)) {
            const brightness = Number.isInteger(status) ? `&brightness=${status}` : '';
            return 'http://' + device.ip + `/light/${index}/?${turn}${brightness}`;
        }
        return 'http://' + device.ip + `/relay/${index}/?${turn}`;
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

    async getStatus(id, forced, callback) {
        let identifiers;
        if (!id) {
            identifiers = [ ...this.indexes.keys()];
        } else {
            identifiers = [id];
        }

        identifiers.forEach(async (id) => {
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

            try {
                let response = await this.sendJSONRequest({url: this.getGetStatusUrl(device), authentication: device.authentication});
                this.current_status.set(id, response);
                this.current_status_time.set(id, Date.now());
                const callbacks = this.status_callbacks.get(id);
                this.status_callbacks.set(id, []);

                this.log.debug(`Calling ${callbacks.length} queued callbacks`);
                callbacks.forEach((element) => {
                    element(null, response);
                });
                this.setupUpdateTimer(id);
            } catch (e) {
                this.log.error(`Error parsing current status info: ${e}`);
                const callbacks = this.status_callbacks.get(id);
                this.status_callbacks.set(id, []);

                callbacks.forEach((element) => {
                    element(e);
                });

                this.setupUpdateTimer(id);
            }
        });


    }

  getGetStatusUrl(device) {
    return this.isDimmer(device) ? `http://${device.ip}/light/0`    : `http://${device.ip}/relay/0`;
  }

  isExposable(type) {
        const exposable = type === 'momentary' || type === 'detached';
        this.log.debug(`Is ${type} exposable? ${exposable}`);
        return exposable;
    }

    async canExposeButton(id, callback) {
        try {
            let settings = await this.getSettings(id);
            if (!settings['relays']) {
                callback(Error('No relays found'));
            }
            callback(this.isExposable(settings.relays[0].btn_type));
        } catch(e) {
            callback(e);
        }
    }

    async getSettings(id) {
        const device = this.devices[this.indexes.get(id)];
        return await this.sendJSONRequest({url: 'http://' + device.ip + '/settings', authentication: device.authentication})
    }

    async sendJSONRequest(params) {
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
                        this.log.debug(`Raw response: ${chunks}`, options, params.url);
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

    isDimmer(device) {
        const { deviceType } = device;
        return deviceType === DEVICE_TYPE_DIMMER;
    }
}
