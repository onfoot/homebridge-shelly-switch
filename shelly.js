const http = require('http');

class JsonParseError extends Error {
    constructor(message, unparsedResponse) {
        super(message);
        this.name = 'JsonParseError';
        this.unparsedResponse = unparsedResponse;
    }
}

class RequestTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RequestTimeoutError';
    }
}

class HttpNotificationServer {
    constructor(port = 3599, logger) {
        this.port = port;
        this.logger = logger;
        this.inputSubscriptions = {};

        this.notification_server = http.createServer((req, res) => {
            this.serverHandler(req, res);
        });

        this.notification_server.listen(this.port, '0.0.0.0', () => {
            this.logger.debug(`Started status notification server at port ${this.port}`);
        });
    }

    subscribe(hostname, subscriber) {
        console.log(`Registering ${hostname}`);
        this.inputSubscriptions[hostname] = subscriber;
    }

    serverHandler(req, res) {
        this.logger.debug(`Notification received from ${req.socket.remoteAddress}`);
        // find the device
        let remoteAddress = req.socket.remoteAddress;

        this.logger.debug(`device found ${remoteAddress}, adress family ${req.socket.remoteFamily}`);

        const foundSubscription = this.inputSubscriptions[remoteAddress];

        if (!foundSubscription) {
            this.logger.debug('Unknown device');
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        if (req.url.endsWith('/status')) {
            foundSubscription.update();
            res.writeHead(200);
            res.end('OK');
            return;
        }

        const buttonRegex = "/button\/([0-9]+)\/(short|long|double)";
        const buttonFound = req.url.match(buttonRegex);

        if (buttonFound) {
            switch (buttonFound[2]) {
                case "short":
                    foundSubscription.shortPress(buttonFound[1]);
                    res.writeHead(200);
                    res.end('OK');
                    return;
                case "long":
                    foundSubscription.longPress(buttonFound[1]);
                    res.writeHead(200);
                    res.end('OK');
                    return;
                case "double":
                    foundSubscription.doublePress(buttonFound[1]);
                    res.writeHead(200);
                    res.end('OK');
                    return;
                default:
                    break;
            }
        }

        res.writeHead(404);
        res.end('Not Found');
    }

}

class DefaultRequestCoder {
    encodeStateUrl(index, state) {
        return `/relay/${index}?turn=${state.power ? 'on' : 'off'}`;
    }

    decodeStateResponse(response) {
        const outputs = response.relays;
        if (outputs) {
            const outputDict = {};
            outputs.forEach((val, index) => outputDict[index] = {power: val});
            return {outputs: outputDict};
        } else {
            return {outputs: {}};
        }
    }

    decodeConfigurationResponse(response) {
        let outputs = [];
        let inputs = [];
        if (response.relays) {
            response.relays.forEach((relay, index) => {
                outputs.push(index);
                if (this.isExposable(relay)) {
                    inputs.push(index);
                }
            });
        }
        else if (response.inputs) {
            response.inputs.forEach((input, index) => {
                if (this.isExposable(input)) {
                    inputs.push(index);
                }
            });
        }

        return {
            outputs,
            inputs
        }
    }

    isExposable(relay) {
        return relay.btn_type === 'momentary' || relay.btn_type === 'detached';
    }
}

class ShellyHttpTransport {
    constructor(requestCoder, hostname, port = 80, timeout = 2000) {
        this.hostname = hostname;
        this.port = port;
        this.timeout = timeout;
        this.requestCoder = requestCoder;
    }

    async sendHttpRequest({ path, method, data = undefined }) {
        const options = {
            hostname: this.hostname,
            port: this.port,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data ? Buffer.byteLength(data) : 0
            },
            timeout: this.timeout
        };

        return new Promise((resolve, reject) => {
            const req = http.request(options, res => {
                let response = '';
                res.on('data', chunk => {
                    response += chunk;
                });
                res.on('end', () => {
                    resolve(response);
                });
            });

            req.on('error', error => {
                reject(error);
            });

            if (data) {
                req.write(data);
            }

            req.end();
        });
    }

    jsonEncoder(data) {
        return JSON.stringify(data);
    }

    jsonDecoder(data) {
        try {
            return JSON.parse(data);
        } catch (error) {
            throw new JsonParseError(error.message, data);
        }
    }

    async setState(index, state) {
        const options = {
            hostname: this.hostname,
            port: this.port,
            path: this.requestCoder.encodeStateUrl(index, state),
            method: 'GET'
        };
        return this.sendHttpRequest(options);
    }

    async getState() {
        const options = {
            hostname: this.hostname,
            port: this.port,
            path: '/status',
            method: 'GET'
        };
        const response = await this.sendHttpRequest(options);
        const jsonResponse = this.jsonDecoder(response);
        return this.requestCoder.decodeStateResponse(jsonResponse);
    }    

    async getConfiguration() {
        const options = {
            path: `/settings`,
            method: 'GET'
        };
        const response = await this.sendHttpRequest(options);
        const jsonResponse = this.jsonDecoder(response);
        return this.requestCoder.decodeConfigurationResponse(jsonResponse);
    }
}

class Shelly {
    constructor(shellyTransport) {
        this.shellyTransport = shellyTransport;
    }

    async turnOn(index) {
        return await this.shellyTransport.setState(index, {power: true});
    }

    async turnOff(index) {
        return await this.shellyTransport.setState(index, {power: false});
    }

    async getState() {
        return await this.shellyTransport.getState();
    }

    async getConfiguration() {
        return await this.shellyTransport.getConfiguration();
    }
}

module.exports = { Shelly, ShellyHttpTransport, DefaultRequestCoder, HttpNotificationServer };