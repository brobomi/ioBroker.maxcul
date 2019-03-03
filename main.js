/* jshint -W097 */// jshint strict:false
/*jslint node: true */

'use strict';
// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core'); // Get common adapter utils

let max;
const objects = {};
let SerialPort;
const devices = {};
const timers = {};
let limitOverflow = null;
let credits = 0;
let connected = false;
let creditsTimer;
let thermostatTimer;

try {
    SerialPort = require('serialport');
} catch (err) {
    console.error('Cannot load serialport module');
}

const adapter = utils.Adapter('maxcul');

adapter.on('stateChange', (id, state) => {
    if (!id || !state || state.ack) return;
    if (!objects[id] || !objects[id].native) {
        adapter.log.warn('Unknown ID: ' + id);
        return;
    }
    if (!objects[id].common.write) {
        adapter.log.warn('id "' + id + '" is readonly');
        return;
    }
    let channel = id.split('.');
    const name = channel.pop();
    const type = channel[channel.length - 1];
    if (type === 'config' ||
        type === 'displayConfig' ||
        type === 'valveConfig') channel.pop();

    channel = channel.join('.');

    if (name === 'display') {
        if (!max) return;
        if (state.val === 'false' || state.val === '0') state.val = false;
        adapter.log.debug('sendSetDisplayActualTemperature(' + channel + ', ' + state.val + ')');
        max.sendSetDisplayActualTemperature(
            objects[channel].native.src,
            state.val);
    } else {
        if (timers[channel]) clearTimeout(timers[channel].timer);

        timers[channel] = timers[channel] || {};
        timers[channel][name] = state.val;
        timers[channel].timer = setTimeout(ch => sendInfo(ch), 1000, channel);
    }
});

adapter.on('unload', callback => {
    if (adapter && adapter.setState) adapter.setState('info.connection', false, true);
    if (max) max.disconnect();
    callback();
});

adapter.on('ready', main);

adapter.on('message', obj => {
    if (obj) {
        switch (obj.command) {
            case 'listUart':
                if (obj.callback) {
                    if (SerialPort) {
                        // read all found serial ports
                        SerialPort.list((err, ports) => {
                            adapter.log.info('List of port: ' + JSON.stringify(ports));
                            adapter.sendTo(obj.from, obj.command, ports, obj.callback);
                        });
                    } else {
                        adapter.log.warn('Module serialport is not available');
                        adapter.sendTo(obj.from, obj.command, [{comName: 'Not available'}], obj.callback);
                    }
                }

                break;
        }
    }
});

function checkPort(callback) {
    if (!adapter.config.serialport) {
        if (callback) callback('Port is not selected');
        return;
    }
    let sPort;
    try {
        sPort = new SerialPort(adapter.config.serialport || '/dev/ttyACM0', {
            baudRate: parseInt(adapter.config.baudrate, 10) || 9600,
            autoOpen: false
        });
        sPort.on('error', err => {
            if (sPort.isOpen()) sPort.close();
            if (callback) callback(err);
            callback = null;
        });

        sPort.open(err => {
            if (sPort.isOpen()) sPort.close();

            if (callback) callback(err);
            callback = null;
        });
    } catch (e) {
        adapter.log.error('Cannot open port: ' + e);
        try {
            if (sPort.isOpen()) sPort.close();
        } catch (ee) {

        }
        if (callback) callback(e);
    }
}

function sendConfig(channel) {
    if (!max) return;
    max.sendConfig(
        objects[channel].native.src,
        timers[channel].comfortTemperature,
        timers[channel].ecoTemperature,
        timers[channel].minimumTemperature,
        timers[channel].maximumTemperature,
        timers[channel].offset,
        timers[channel].windowOpenTime,
        timers[channel].windowOpenTemperature,
        objects[channel].native.type);

    delete timers[channel].comfortTemperature;
    delete timers[channel].ecoTemperature;
    delete timers[channel].minimumTemperature;
    delete timers[channel].maximumTemperature;
    delete timers[channel].windowOpenTime;
    delete timers[channel].offset;
    delete timers[channel].windowOpenTemperature;
}

function sendValveConfig(channel) {
    if (!max) return;
    max.sendConfigValve(
        objects[channel].native.src,
        timers[channel].boostDuration,
        timers[channel].boostValvePosition,
        timers[channel].decalcificationDay,
        timers[channel].decalcificationHour,
        timers[channel].maxValveSetting,
        timers[channel].valveOffset,
        objects[channel].native.type);

    delete timers[channel].boostDuration;
    delete timers[channel].boostValvePosition;
    delete timers[channel].decalcificationDay;
    delete timers[channel].decalcificationHour;
    delete timers[channel].maxValveSetting;
    delete timers[channel].valveOffset;
}

function sendTemperature(channel) {
    if (!max) return;
    adapter.log.debug('sendTemperature(' + channel + ', ' + timers[channel].desiredTemperature + ', ' + timers[channel].mode + ')');
    max.sendDesiredTemperature(
        objects[channel].native.src,
        timers[channel].desiredTemperature,
        timers[channel].mode,
        '00',
        objects[channel].native.type);
    delete timers[channel].mode;
    delete timers[channel].desiredTemperature;
}

function sendInfo(channel) {
    if (!timers[channel]) return;

    if (credits < 220) {
        adapter.log.warn('Not enough credits(' + credits + '). Wait for more...');
        timers[channel].timer = setTimeout(() => sendInfo(channel), 5000);
        return;
    }

    timers[channel].timer = null;

    if (timers[channel].mode !== undefined || timers[channel].desiredTemperature !== undefined) {
        timers[channel].requestRunning = false;

        let count1 = 0;
        if (timers[channel].mode === undefined) {
            count1++;
            adapter.getForeignState(channel + '.mode', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 0;
                }
                timers[channel].mode = state.val;
                if (!--count1) sendTemperature(channel);
            });
        }
        if (timers[channel].desiredTemperature === undefined) {
            count1++;
            adapter.getForeignState(channel + '.desiredTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 21;
                }
                timers[channel].desiredTemperature = state.val;
                if (!--count1) sendTemperature(channel);
            });
        }
        if (!count1) sendTemperature(channel);
    }
    // comfortTemperature, ecoTemperature, minimumTemperature, maximumTemperature, offset, windowOpenTime, windowOpenTemperature
    if (timers[channel].comfortTemperature      !== undefined ||
        timers[channel].ecoTemperature          !== undefined ||
        timers[channel].minimumTemperature      !== undefined ||
        timers[channel].maximumTemperature      !== undefined ||
        timers[channel].offset                  !== undefined ||
        timers[channel].windowOpenTime          !== undefined ||
        timers[channel].windowOpenTemperature   !== undefined) {
        let count2 = 0;
        if (timers[channel].comfortTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.comfortTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 21;
                }
                timers[channel].comfortTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].ecoTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.ecoTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 17;
                }
                timers[channel].ecoTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].minimumTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.minimumTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 4.5;
                }
                timers[channel].minimumTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].maximumTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.maximumTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 30.5;
                }
                timers[channel].maximumTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].offset === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.offset', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 0;
                }
                timers[channel].offset = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].windowOpenTime === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.windowOpenTime', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 10;
                }
                timers[channel].windowOpenTime = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (timers[channel].windowOpenTemperature === undefined) {
            count2++;
            adapter.getForeignState(channel + '.config.windowOpenTemperature', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 12;
                }
                timers[channel].windowOpenTemperature = state.val;
                if (!--count2) sendConfig(channel);
            });
        }
        if (!count2) sendConfig(channel);
    }

    // boostDuration, boostValvePosition, decalcificationDay, decalcificationHour, maxValveSetting, valveOffset
    if (timers[channel].boostDuration         !== undefined ||
        timers[channel].boostValvePosition    !== undefined ||
        timers[channel].decalcificationDay    !== undefined ||
        timers[channel].decalcificationHour   !== undefined ||
        timers[channel].maxValveSetting       !== undefined ||
        timers[channel].valveOffset           !== undefined) {

        let count3 = 0;
        if (timers[channel].boostDuration === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.boostDuration', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 5;
                }
                timers[channel].boostDuration = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].boostValvePosition === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.boostValvePosition', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 100;
                }
                timers[channel].boostValvePosition = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].decalcificationDay === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.decalcificationDay', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 0;
                }
                timers[channel].decalcificationDay = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].decalcificationHour === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.decalcificationHour', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 12;
                }
                timers[channel].decalcificationHour = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].maxValveSetting === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.maxValveSetting', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 100;
                }
                timers[channel].maxValveSetting = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (timers[channel].valveOffset === undefined) {
            count3++;
            adapter.getForeignState(channel + '.valveConfig.valveOffset', (err, state) => {
                if (!state || state.val === null || state.val === undefined) {
                    state = state || {};
                    state.val = 0;
                }
                timers[channel].valveOffset = state.val;
                if (!--count3) sendValveConfig(channel);
            });
        }
        if (!count3) sendValveConfig(channel);
    }
}

const tasks = [];

function processTasks() {
    if (tasks.length) {
        const task = tasks.shift();
        if (task.type === 'state') {
            adapter.setForeignState(task.id, task.val, true, () => setTimeout(processTasks, 0));
        } else if (task.type === 'object') {
            adapter.getForeignObject(task.id, (err, obj) => {
                if (!obj) {
                    objects[task.id] = task.obj;
                    adapter.setForeignObject(task.id, task.obj, (err, res) => {
                        adapter.log.info('object ' + adapter.namespace + '.' + task.id + ' created');
                        setTimeout(processTasks, 0);
                    });
                } else {
                    let changed = false;
                    if (JSON.stringify(obj.native) !== JSON.stringify(task.obj.native)) {
                        obj.native = task.obj.native;
                        changed = true;
                    }

                    if (changed) {
                        objects[obj._id] = obj;
                        adapter.setForeignObject(obj._id, obj, (err, res) => {
                            adapter.log.info('object ' + adapter.namespace + '.' + obj._id + ' created');
                            setTimeout(processTasks, 0);
                        });
                    } else {
                        setTimeout(processTasks, 0);
                    }
                }
            });
        } else {
            adapter.log.error('Unknown task: ' + task.type);
            setTimeout(processTasks, 0);
        }
    }
}

function setStates(obj) {
    const id = obj.serial;
    const isStart = !tasks.length;
    if (!devices[obj.data.src]) return;

    devices[obj.data.src].lastReceived = new Date().getTime();

    for (const state in obj.data) {
        if (!obj.data.hasOwnProperty(state)) continue;
        if (state === 'src') continue;
        if (state === 'serial') continue;
        if (obj.data[state] === undefined) continue;

        const oid  = adapter.namespace + '.' + id + '.' + state;
        const meta = objects[oid];
        let val  = obj.data[state];

        if (state === 'desiredTemperature' && timers[adapter.namespace + '.' + id] && timers[adapter.namespace + '.' + id].requestRunning) {
            adapter.log.debug('Ignore desiredTemperature: ' + val);
            timers[adapter.namespace + '.' + id].desiredTemperature = timers[adapter.namespace + '.' + id].requestRunning;
            timers[adapter.namespace + '.' + id].requestRunning = false ;

            setTimeout(channel => sendInfo(channel), 0, adapter.namespace + '.' + id);
            continue;
        }

        if (meta) {
            if (meta.common.type === 'boolean') {
                val = val === 'true' || val === true || val === 1 || val === '1' || val === 'on';
            } else if (meta.common.type === 'number') {
                if (val === 'on'  || val === 'true'  || val === true)  val = 1;
                if (val === 'off' || val === 'false' || val === false) val = 0;
                val = parseFloat(val);
            }
        }
        if (objects[oid]) {
            tasks.push({type: 'state', id: oid, val: val});
        }
    }
    if (isStart) processTasks();
}

function syncObjects(objs) {
    const isStart = !tasks.length;
    for (let i = 0; i < objs.length; i++) {
        if (objs[i].native && objs[i].native.type && !devices[objs[i].native.src]) {
            devices[objs[i].native.src] = objs[i];
        }
        tasks.push({type: 'object', id: objs[i]._id, obj: objs[i]});
    }
    if (isStart) processTasks()
}

function hex2a(hexx) {
    const hex = hexx.toString();//force conversion
    let str = '';
    for (let i = 0; i < hex.length; i += 2) {
        const s = String.fromCharCode(parseInt(hex.substr(i, 2), 16));
        // serial is ABC1324555
        if ((s >= 'A' && s <= 'Z') || (s >= 'a' && s <= 'z') || (s >= '0' && s <= '9')) {
            str += s;
        } else {
            return '';
        }
    }
    return str;
}

function createThermostat(data, prefix) {
    //const t = {
    //    "src": "160bd0",
    //    "mode": 1,                   // <==
    //    "desiredTemperature": 30.5,  // <==
    //    "valvePosition": 100,        // <==
    //    "measuredTemperature": 22.4, // <==
    //    "dstSetting": 1,             // <==
    //    "langateway": 1,             // <==
    //    "panel": 0,                  // <==
    //    "rfError": 0,                // <==
    //    "batteryLow": 0,             // <==
    //    "untilString": ""
    //};

    // comfortTemperature, ecoTemperature, minimumTemperature, maximumTemperature, offset, windowOpenTime, windowOpenTemperature
    prefix = prefix || '';

    if (!data.serial && data.raw) {
        data.serial = hex2a(data.raw.substring(data.raw.length - 20));
    }

    if (!data.serial) {
        data.serial = data.src.toUpperCase();
    }

    let obj = {
        _id: adapter.namespace + '.' + data.serial,
        common: {
            role: 'thermostat',
            name: prefix + 'Thermostat ' + data.serial + ' | ' + data.src
        },
        type: 'channel',
        native: data
    };
    const objs = [obj];
    obj = {
        _id: adapter.namespace + '.' + data.serial + '.mode',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' mode',
            type: 'number',
            role: 'level.mode',
            read: true,
            write: true,
            states: {
                0: 'auto',
                1: 'manual',
                3: 'boost'
            }
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.measuredTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' current temperature',
            type: 'number',
            read: true,
            write: false,
            role: 'value.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.desiredTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' set temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valvePosition',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' valve',
            type: 'number',
            read: true,
            write: false,
            role: 'value.valve',
            unit: '%',
            min: 0,
            max: 100
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rfError',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' error',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.reachable'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.batteryLow',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' low battery',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.battery'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    // comfortTemperature,
    // ecoTemperature,
    // minimumTemperature,
    // maximumTemperature,
    // offset,
    // windowOpenTime,
    // windowOpenTemperature
    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.comfortTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' comfort temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.ecoTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' eco temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.minimumTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' minimum temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.maximumTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' maximum temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.offset',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' offset temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.windowOpenTemperature',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' window open temperature',
            type: 'number',
            read: true,
            write: true,
            min: 4.5,
            max: 30.5,
            role: 'level.temperature',
            unit: '°C'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.config.windowOpenTime',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' window open time',
            type: 'number',
            read: true,
            write: true,
            role: 'level.interval',
            unit: 'sec'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rssi',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' signal strength',
            type: 'number',
            read: true,
            write: false,
            role: 'value.rssi',
            unit: 'dBm'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.boostDuration',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' boost duration',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 60,
            role: 'level.duration',
            unit: 'sec'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.boostValvePosition',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' boost valve position',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 100,
            role: 'level.valve',
            unit: '%'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.decalcificationDay',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' decalcification week day',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 6,
            states: {
                0: 'Sunday',
                1: 'Monday',
                2: 'Tuesday',
                3: 'Wednesday',
                4: 'Thursday',
                5: 'Friday',
                6: 'Saturday'
            },
            role: 'level.day',
            unit: '%'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.decalcificationHour',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' decalcification hour',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 23,
            role: 'level.hour',
            unit: 'hour'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.maxValveSetting',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' max valve position',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 100,
            role: 'level.valve',
            unit: '%'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.valveConfig.valveOffset',
        common: {
            name: prefix + 'Thermostat ' + data.serial + ' valve offset',
            type: 'number',
            read: true,
            write: true,
            min: 0,
            max: 100,
            role: 'level.valve',
            unit: '%'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    syncObjects(objs);
}

function createWallThermostat(data) {
    createThermostat(data, 'Wall');

    const obj = {
        _id: adapter.namespace + '.' + data.serial + '.displayConfig.display',
        common: {
            name:  'WallThermostat ' + data.serial + ' display',
            type:  'boolean',
            desc:  'Display actual temperature',
            role:  'switch',
            read:  true,
            write: true
        },
        type:  'state',
        native: data
    };
    syncObjects([obj]);
}

function createButton(data) {
    //const t = {
    //    "src": "160bd0",
    //    "isOpen": 1,                   // <==
    //    "rfError": 30.5,  // <==
    //    "batteryLow": 100
    //};

    if (!data.serial && data.raw) {
        data.serial = hex2a(data.raw.substring(data.raw.length - 20));
    }

    if (!data.serial) data.serial = data.src.toUpperCase();

    let obj = {
        _id: adapter.namespace + '.' + data.serial,
        common: {
            role: 'button',
            name: 'Push button ' + data.serial
        },
        type: 'channel',
        native: data
    };
    const objs = [obj];
    obj = {
        _id: adapter.namespace + '.' + data.serial + '.pressed',
        common: {
            name: 'Push button ' + data.serial + ' pressed',
            type: 'boolean',
            role: 'button',
            read: true,
            write: false
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rfError',
        common: {
            name: 'Push button ' + data.serial + ' error',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.reachable'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.batteryLow',
        common: {
            name: 'Push button ' + data.serial + ' low battery',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.battery'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rssi',
        common: {
            name: 'Push button ' + data.serial + ' signal strength',
            type: 'number',
            read: true,
            write: false,
            role: 'value.rssi',
            unit: 'dBm'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    syncObjects(objs);
}

function createContact(data) {
    //const t = {
    //    "src": "160bd0",
    //    "isOpen": 1,                   // <==
    //    "rfError": 30.5,  // <==
    //    "batteryLow": 100
    //};

    if (!data.serial && data.raw) {
        data.serial = hex2a(data.raw.substring(data.raw.length - 20));
    }

    if (!data.serial) data.serial = data.src.toUpperCase();

    let obj = {
        _id: adapter.namespace + '.' + data.serial,
        common: {
            role: 'indicator',
            name: 'Push button ' + data.serial
        },
        type: 'channel',
        native: data
    };
    const objs = [obj];
    obj = {
        _id: adapter.namespace + '.' + data.serial + '.isOpen',
        common: {
            name: 'Contact ' + data.serial + ' opened',
            type: 'boolean',
            role: 'button',
            read: true,
            write: false
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rfError',
        common: {
            name: 'Contact ' + data.serial + ' error',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.reachable'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.batteryLow',
        common: {
            name: 'Contact ' + data.serial + ' low battery',
            type: 'boolean',
            read: true,
            write: false,
            role: 'indicator.battery'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    obj = {
        _id: adapter.namespace + '.' + data.serial + '.rssi',
        common: {
            name: 'Contact ' + data.serial + ' signal strength',
            type: 'number',
            read: true,
            write: false,
            role: 'value.rssi',
            unit: 'dBm'
        },
        type: 'state',
        native: data
    };
    objs.push(obj);

    syncObjects(objs);
}

function pollDevice(id) {
    const src = objects[id].native.src;
    if (credits < 400 || !devices[src]) {
        return;
    }
    devices[src].lastReceived = new Date().getTime();
    adapter.getForeignState(id + '.mode', (err, state) => {
        adapter.getForeignState(id + '.desiredTemperature', (err, stateTemp) => {
            if (state && state.val !== null && state.val !== undefined) {
                let newVal = stateTemp.val;
                const oldVal = stateTemp.val;
                newVal = newVal + 0.5;
                if (newVal > 30) newVal = 29.5;
                const mode   = state.val;
                timers[id] = timers[id] || {};
                if (timers[id].requestRunning) {
                    adapter.log.info('Poll device1 : ' + mode + ', ' + newVal + ' ignored, still running');
                    return;
                }
                timers[id].requestRunning = oldVal;
                adapter.log.info('Poll device1 : ' + mode + ', ' + newVal);

                max.sendDesiredTemperature(
                    src,
                    newVal,
                    mode,
                    '00',
                    objects[id].native.type);
            }
        });
    });
}

function connect() {
    adapter.setState('info.connection', false, true);
    if (!adapter.config.serialport) {
        adapter.log.warn('Please define the serial port.');
        return;
    }

    const env = {
        logger: adapter.log
    };

    const Max = require(__dirname + '/lib/maxcul')(env);

    max = new Max(adapter.config.baseAddress, true, adapter.config.serialport, parseInt(adapter.config.baudrate, 10) || 9600);

    creditsTimer = setInterval(() => max.getCredits(), 5000);

    if (adapter.config.scanner) {
        thermostatTimer = setInterval(() => {
            const now = new Date().getTime();
            for (const id in objects) {
                if (objects.hasOwnProperty(id) && objects[id].type === 'channel' && (objects[id].native.type === 1 || objects[id].native.type === 2 || objects[id].native.type === 3)) {
                    if (devices[objects[id].native.src] && (!devices[objects[id].native.src].lastReceived || now - devices[objects[id].native.src].lastReceived > adapter.config.scanner * 60000)) {
                        pollDevice(id);
                    }
                }
            }
        }, 60000);
    }

    max.on('creditsReceived', (credit, credit1) => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }

        credits = parseInt(credit, 10);
        if (credits < 120) {
            if (!limitOverflow) {
                limitOverflow = true;
                adapter.setState('info.limitOverflow', true, true);
            }
        } else {
            if (limitOverflow === null || limitOverflow) {
                limitOverflow = false;
                adapter.setState('info.limitOverflow', false, true);
            }
        }
        adapter.setState('info.quota', credits, true);
    });

    max.on('ShutterContactStateReceived', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        adapter.log.debug('ShutterContactStateReceived: ' + JSON.stringify(data));
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            createButton(data);
        }
    });

    max.on('culFirmwareVersion', data => {
        adapter.setState('info.version', data, true);
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
    });

    max.on('WallThermostatStateRecieved', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            createWallThermostat(data);
        }
        adapter.log.debug('WallThermostatStateReceived: ' + JSON.stringify(data));
    });

    max.on('WallThermostatControlRecieved', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            //createWallThermostat(data);
        }
        adapter.log.debug('WallThermostatControlRecieved: ' + JSON.stringify(data));
    });

    max.on('ThermostatStateReceived', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        //ThermostatStateReceived: {"src":"160bd0","mode":1,"desiredTemperature":30.5,"valvePosition":100,"measuredTemperature":22.4,"dstSetting":1,"lanGateway":1,"panel":0,"rfError":0,"batteryLow":0,"untilString":""}
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            createThermostat(data);
        }
        adapter.log.debug('ThermostatStateReceived: ' + JSON.stringify(data));
    });

    max.on('PushButtonStateReceived', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        adapter.log.debug('PushButtonStateReceived: ' + JSON.stringify(data));
        if (devices[data.src]) {
            setStates({serial: devices[data.src].native.serial, data: data});
        } else {
            adapter.log.warn('Unknown device: ' + JSON.stringify(data));
            createButton(data);
        }
    });

    max.on('checkTimeIntervalFired', () => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }

        adapter.log.info('checkTimeIntervalFired');
        adapter.log.debug('Updating time information for deviceId');
        max.sendTimeInformation(adapter.config.baseAddress);
    });

    max.on('deviceRequestTimeInformation', src => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        adapter.log.info('deviceRequestTimeInformation: ' + JSON.stringify(src));
        adapter.log.debug('Updating time information for deviceId ' + src);
        if (devices[src]) {
            max.sendTimeInformation(src, devices[src].native.type);
        }
    });

    max.on('LOVF', () => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        adapter.log.debug('LOVF: credits=' + credits);
        if (!limitOverflow) {
            limitOverflow = true;
            adapter.setState('info.limitOverflow', true, true);
        }
    });

    max.on('PairDevice', data => {
        if (!connected) {
            connected = true;
            adapter.setState('info.connection', true, true);
        }
        if (limitOverflow) {
            limitOverflow = false;
            adapter.setState('info.limitOverflow', false, true);
        }
        adapter.log.info('PairDevice: ' + JSON.stringify(data));
        if (data.type === 1 || data.type === 2 /*|| data.type === 3*/) {
            createThermostat(data);
        } else if (data.type === 3) {
            createWallThermostat(data);
        } else if (data.type === 4) {
            createContact(data);
        } else if (data.type === 5) {
            createButton(data);
        } else {
            adapter.log.warn('Received unknown type: ' + JSON.stringify(data));
        }
    });

    if (adapter.config.serialport && adapter.config.serialport !== 'DEBUG') {
        max.connect();
    } else if (adapter.config.serialport === 'DEBUG') {
        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd0',
                type: 1,
                raw: 'Z17000400160BD0123456001001A04E455130363731393837'
            });
        }, 100);

        setTimeout(() => {
            max.emit('ThermostatStateReceived', {
                src: '160bd0',
                mode: 1,
                desiredTemperature: 30.5,
                valvePosition: 100,
                measuredTemperature: 22.4,
                dstSetting: 1,
                lanGateway: 1,
                panel: 0,
                rfError: 0,
                batteryLow: 0,
                untilString: '',
                rssi: 10
            });
        }, 1200);

        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd1',
                type: 5,
                raw: 'Z17000400160BD0123456001001A04E455130363731393839'
            });
        }, 300);

        setTimeout(() => {
            max.emit('PushButtonStateReceived', {
                src: '160bd1',
                pressed: 1,
                rfError: 1,
                batteryLow: 0,
                rssi: 10
            });
        }, 1400);

        setTimeout(() => {
            max.emit('PairDevice', {
                src: '160bd2',
                type: 4,
                raw: 'Z17000400160BD0123456001001A04E455130363731393838'
            });
        }, 300);

        setTimeout(() => {
            max.emit('ShutterContactStateReceived', {
                src: '160bd2',
                isOpen: 0,
                rfError: 0,
                batteryLow: 1,
                rssi: 10
            });
        }, 1400);
    } else {
        adapter.log.warn('No serial port defined!');
    }
}

function main() {
    if (adapter.config.scanner === undefined) {
        adapter.config.scanner = 10;
    }
    adapter.config.scanner = parseInt(adapter.config.scanner, 10) || 0;

    adapter.objects.getObjectView('system', 'channel', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, (err, res) => {
        for (let i = 0, l = res.rows.length; i < l; i++) {
            objects[res.rows[i].id] = res.rows[i].value;
        }
        adapter.objects.getObjectView('system', 'state', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, (err, res) => {
            for (let i = 0, l = res.rows.length; i < l; i++) {
                objects[res.rows[i].id] = res.rows[i].value;
                if (objects[res.rows[i].id].native && objects[res.rows[i].id].native.src) {
                    devices[objects[res.rows[i].id].native.src] = objects[res.rows[i].id];
                }
            }
            connect();
            adapter.subscribeStates('*');
        });
    });
}
