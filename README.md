# homebridge-shelly-switch

`homebridge-shelly-switch` is a [Homebridge](https://github.com/nfarina/homebridge) plugin you can use to control your Shelly 1 in-wall switch. I've had it with only Shelly's CoAP not working reliably so I made a purely HTTP plugin. The configuration is a bit more cumbersome, but there's no magic, just HTTP calls in both ways.

## Installation

`npm -g install homebridge-shelly-switch`

## Configuration

An entry in `config.json`'s "platforms" section is needed of the following basic form:

```
{
    "platform": "Shelly Switch",
    "devices": [
      {
        "name": "<e.g. Kitchen>",
        "ip": "<shelly's ip address>"
      }
    ]
}
```

If your shelly web interface is restricted with login and password, you need to add a `authentication` option with the value of `<username>:<password>` to device's config.

Example for when username and password are "admin" (not recommended!):

```
{
    "name": "<e.g. Kitchen>",
    "ip": "<shelly's ip address>",
    "authentication": "admin:admin"
}
```

# Status notifications

Shellies have the ability to call action URLs in the event of switches changing their state. This frees the plugin from constantly polling the status of the switch, and instead will get pinged on the status update, which improves responsiveness of any HomeKit actions that could be performed, especially when using the physical switch or an automation. For example, if it's dark outside, after I turn on Kitchen light, kitchen counter lights turn on too.

If you want to set up the notifications, which is highly recommended, you need to add a `notification_port` option to the top plugin config dictionary with a specified HTTP port on which the plugin will listen.

Example:

```
{
    "platform": "Shelly Switch",
    "notification_port": 54220,
    ...
}
```

The action URLs you need to set up in Shelly configuration Actions section (for `OUTPUT SWITCHED ON URL` and `OUTPUT SWITCHED OFF URL`) shall be `http://<homebridge-host-ip>:<notification_port>/status`, e.g. `http://192.168.0.1:54220/status`.


# Notes

Two and more relay switches are not yet supported. Will probably implement Shelly 2.5 in relay mode (as shutter mode is supported by my [other](https://github.com/onfoot/homebridge-shelly-shutter) plugin).

I'll also most likely expose the short/long press actions as programmable HomeKit buttons.

I'm also toying with an idea of setting up the action URLs in the switch settings automatically once status notifications are enabled.
