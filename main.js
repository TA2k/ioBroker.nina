"use strict";

/*
 * Created with @iobroker/create-adapter v1.16.0
 */

const utils = require("@iobroker/adapter-core");
const request = require("request");
const traverse = require("traverse");

class Nina extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "nina"
        });
        this.on("ready", this.onReady.bind(this));
        // this.on("objectChange", this.onObjectChange.bind(this));
        // this.on("stateChange", this.onStateChange.bind(this));
        // this.on("message", this.onMessage.bind(this));
        this.on("unload", this.onUnload.bind(this));

        this.currentGefahren = {};
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Initialize your adapter here

        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);

        //clean all ags /devices
        const pre = this.name + "." + this.instance;
        this.getStates(pre + ".*", (err, states) => {
            const allIds = Object.keys(states);
            allIds.forEach(keyName => {
                if (!states[keyName]) {
                    this.delObject(
                        keyName
                            .split(".")
                            .slice(2)
                            .join(".")
                    );
                }
            });
        });

        this.agsArray = [];
        if (this.config.agsArray) {
            this.agsArray = this.config.agsArray.replace(/ /g, "").split(",");
        }
        if (this.config.example) {
            this.agsArray.push("Beispielwarnung");
        }
        request.get(
            {
                url: "https://warnung.bund.de/assets/json/suche_channel.json",
                followAllRedirects: true
            },
            (err, resp, body) => {
                let channels = {};
                try {
                    channels = JSON.parse(body);
                } catch (e) {
                    this.log.info(JSON.stringify(e));
                }
                this.agsArray.forEach(element => {
                    let name = "";
                    if (channels[element]) {
                        name = channels[element].NAME;
                    }
                    this.setObjectNotExists(element, {
                        type: "state",
                        common: {
                            name: name,
                            role: "indicator",
                            type: "mixed",
                            write: false,
                            read: true
                        },
                        native: {}
                    });
                    this.setObjectNotExists(element + ".numberOfWarn", {
                        type: "state",
                        common: {
                            name: "Anzahl der aktuellen Warnungen",
                            role: "indicator",
                            type: "number",
                            write: false,
                            read: true
                        },
                        native: {}
                    });
                    this.setObjectNotExists(element + ".identifierList", {
                        type: "state",
                        common: {
                            name: "Liste der Warnungenidentifier",
                            role: "state",
                            type: "array",
                            write: false,
                            read: true
                        },
                        native: {}
                    });
                });
            }
        );
        this.interval = setInterval(() => {
            this.resetWarnings();
            const gefahrenPromise = this.parseJSON("https://warnung.bund.de/bbk.mowas/gefahrendurchsagen.json");
            const unwetterPromise = this.parseJSON("https://warnung.bund.de/bbk.dwd/unwetter.json");
            const hochwasserPromise = this.parseJSON("https://warnung.bund.de/bbk.lhp/hochwassermeldungen.json");
            const biwapp = this.parseJSON("https://warnung.bund.de/bbk.biwapp/warnmeldungen.json");
            const katwarn = this.parseJSON("https://warnung.bund.de/bbk.katwarn/warnmeldungen.json");
            Promise.all([gefahrenPromise, unwetterPromise, hochwasserPromise, biwapp, katwarn]).then(values => {
                this.setGefahren();
            });
        }, this.config.interval * 1000 * 60);

        this.resetWarnings();
        const gefahrenPromise = this.parseJSON("https://warnung.bund.de/bbk.mowas/gefahrendurchsagen.json");
        const unwetterPromise = this.parseJSON("https://warnung.bund.de/bbk.dwd/unwetter.json");
        const hochwasserPromise = this.parseJSON("https://warnung.bund.de/bbk.lhp/hochwassermeldungen.json");
        const biwapp = this.parseJSON("https://warnung.bund.de/bbk.biwapp/warnmeldungen.json");
        const katwarn = this.parseJSON("https://warnung.bund.de/bbk.katwarn/warnmeldungen.json");
        Promise.all([gefahrenPromise, unwetterPromise, hochwasserPromise, biwapp, katwarn]).then(values => {
            this.setGefahren();
        });
    }

    parseJSON(url) {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                request.get(
                    {
                        url: url,
                        followAllRedirects: true,
                        gzip: true
                    },
                    (err, resp, body) => {
                        if (err) {
                            this.log.error("Request error" + JSON.stringify(err));
                            reject();
                            this.setState("info.connection", false, true);
                        }
                        try {
                            this.log.debug(body);
                            const gefahren = JSON.parse(body);
                            this.setState("info.connection", true, true);

                            if (gefahren.length > 0 && this.config.example) {
                                this.currentGefahren["Beispielwarnung"] = [gefahren[0]];
                            }

                            //parseJson
                            gefahren.forEach(element => {
                                element.info.forEach(infoElement => {
                                    infoElement.area.forEach(areaElement => {
                                        areaElement.geocode.forEach(geoElement => {
                                            const trimmedAreaCode = geoElement.value.substring(0, 5);
                                            if (this.agsArray.indexOf(trimmedAreaCode) !== -1) {
                                                if (this.currentGefahren[trimmedAreaCode]) {
                                                    this.currentGefahren[trimmedAreaCode].push(element);
                                                } else {
                                                    this.currentGefahren[trimmedAreaCode] = [element];
                                                }
                                            }
                                        });
                                    });
                                });
                            });

                            resolve();
                        } catch (error) {
                            this.log.error(error + " " + JSON.stringify(error));
                            this.log.debug(body);
                            this.setState("info.connection", false, true);
                            reject();
                        }
                    }
                );
            }, 500);
        });
    }
    resetWarnings() {
        this.currentGefahren = {};
        const pre = this.name + "." + this.instance;
        this.getStates(pre + ".*", (err, states) => {
            const allIds = Object.keys(states);
            allIds.forEach(keyName => {
                if (keyName.indexOf(".warnung") !== -1) {
                    this.delObject(
                        keyName
                            .split(".")
                            .slice(2)
                            .join(".")
                    );
                }
            });
        });
        //create empty current GefahrenObject to have correct numberofWarn
        this.agsArray.forEach(element => {
            this.currentGefahren[element] = [];
        });
    }

    setGefahren() {
        return new Promise((resolve, reject) => {
            const adapter = this;
            Object.keys(this.currentGefahren).forEach(areaCode => {
                this.setState(areaCode + ".numberOfWarn", this.currentGefahren[areaCode].length, true);

                let identifierList = [];
                this.currentGefahren[areaCode].forEach((element, index) => {
                    identifierList.push(element.identifier);
                    let stringIndex = index + 1 + "";
                    while (stringIndex.length < 2) stringIndex = "0" + stringIndex;
                    traverse(element).forEach(function(value) {
                        if (this.path.length > 0 && this.isLeaf) {
                            const modPath = this.path;
                            this.path.forEach((pathElement, pathIndex) => {
                                if (!isNaN(parseInt(pathElement))) {
                                    let stringPathIndex = parseInt(pathElement) + 1 + "";
                                    while (stringPathIndex.length < 2) stringPathIndex = "0" + stringPathIndex;
                                    const key = this.path[pathIndex - 1] + stringPathIndex;
                                    const parentIndex = modPath.indexOf(pathElement) - 1;
                                    //if (this.key === pathElement) {
                                    modPath[parentIndex] = key;
                                    //}
                                    modPath.splice(parentIndex + 1, 1);
                                }
                            });
                            adapter.setObjectNotExists(areaCode + ".warnung" + stringIndex + "." + modPath.join("."), {
                                type: "state",
                                common: {
                                    name: this.key,
                                    role: "indicator",
                                    type: "mixed",
                                    write: false,
                                    read: true
                                },
                                native: {}
                            });
                            adapter.setState(areaCode + ".warnung" + stringIndex + "." + modPath.join("."), value, true);
                        }
                    });
                });

                this.setState(areaCode + ".identifierList", { val: identifierList, ack: true });
            });
            resolve();
        });
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            clearInterval(this.interval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = options => new Nina(options);
} else {
    // otherwise start the instance directly
    new Nina();
}
