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
		this.on("unload", this.onUnload.bind(this));
		this.currentGefahren = {};
		this.status = {};
		this.etags = {};
	}
	async onReady() {
		this.setState("info.connection", false, true);

		this.agsArray = [];
		if (this.config.agsArray) {
			this.agsArray = this.config.agsArray.replace(/ /g, "").split(",");
		}
		if (this.config.example) {
			this.agsArray.push("Beispielwarnung");
		}

		//clean old ags /devices
		const pre = this.name + "." + this.instance;
		this.getStates(pre + ".*", (err, states) => {
			const allIds = Object.keys(states);
			allIds.forEach(keyName => {
				const keyNameArray = keyName.split(".");
				if (keyNameArray.length > 2 && keyNameArray[2] !== "info" && !this.agsArray.includes(keyNameArray[2])) {
					this.delObject(
						keyName
							.split(".")
							.slice(2)
							.join(".")
					);
				}
			});
		});

		request.get(
			{
				url: "https://warnung.bund.de/assets/json/suche_channel.json",
				followAllRedirects: true,
				gzip: true
			},
			(err, resp, body) => {
				let channels = {};
				try {
					channels = JSON.parse(body.replace(/\r/g, "").replace(/\n/g, ""));
				} catch (e) {
					//Error means only device will create without city name
					this.log.debug(JSON.stringify(e));
				}
				this.agsArray.forEach(element => {
					let name = "";
					if (channels[element]) {
						name = channels[element].NAME;
						this.log.info("Found AGS for: " + name);
					}
					this.setObjectNotExists(element, {
						type: "device",
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
					this.setObjectNotExists(element + ".activeWarn", {
						type: "state",
						common: {
							name: "Anzahl der aktiven Warnungen",
							role: "indicator",
							type: "number",
							write: false,
							read: true
						},
						native: {}
					});
					this.setObjectNotExists(element + ".cancelWarn", {
						type: "state",
						common: {
							name: "Anzahl der canceled Warnungen",
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
			this.promiseArray = [];
			this.agsArray.forEach(async element => {
				const promise = new Promise(async (resolve, reject) => {
					await this.checkStatus(element)
						.then(async () => {
							await this.resetWarnings(element);
						})
						.catch(() => {});
					await this.getWarnungen(element)
						.then(() => {})
						.catch(() => {});
					resolve();
				});
				this.promiseArray.push(promise);
			});
			Promise.all(this.promiseArray).then(() => {
				this.setGefahren();
			});
		}, this.config.interval * 1000 * 60);

		//create empty current GefahrenObject to have correct numberofWarn
		await this.resetWarnings();
		this.currentGefahren = {};
		this.status = {};
		this.promiseArray = [];

		this.agsArray.forEach(async element => {
			const promise = new Promise(async (resolve, reject) => {
				this.currentGefahren[element] = [];
				await this.checkStatus(element).catch(() => {});
				await this.getWarnungen(element).catch(() => {});
				resolve();
			});
			this.promiseArray.push(promise);
		});
		Promise.all(this.promiseArray).then(() => {
			this.setGefahren();
		});
	}

	getWarnungen(areaCode) {
		return new Promise((resolve, reject) => {
			const promiseArray = [];
			const refArray = [];
			this.status[areaCode] &&
                Object.keys(this.status[areaCode].buckets).forEach(bucket => {
                	this.status[areaCode].buckets[bucket].forEach(ref => {
                		refArray.push(ref);
                		const requestPromise = new Promise((resolve, reject) => {
                			const headers = {};
                			const url = "https://warnung.bund.de/" + bucket + "/" + ref + ".ohne.json";
                			if (this.etags[areaCode + url]) {
                				headers["If-None-Match"] = this.etags[areaCode + url];
                			}
                			request.get(
                				{
                					url: url,
                					followAllRedirects: true,
                					headers: headers,
                					gzip: true
                				},
                				async (err, resp, body) => {
                					if (err || (resp && resp.statusCode >= 400)) {
                						if (err && err.code === "EPROTO") {
                							this.log.warn(
                								"You using a maybe modern TLS (debian Buster) which is not support by the NINA server. Please adjust in your /etc/ssl/openssl.cnf to CipherString = DEFAULT@SECLEVEL=1"
                							);
                						} else if (err && err.code === "ETIMEDOUT") {
                							this.log.warn("Cannot reach " + url + " Server.");
                						} else if (resp && resp.statusCode >= 400) {
                							this.log.warn("Cannot reach " + url + " Server. Statuscode: " + resp.statusCode);
                						}
                						if (err) {
                							this.log.error("Request error" + JSON.stringify(err));
                						}
                						resolve();
                						this.setState("info.connection", false, true);
                						return;
                					}
                					if (body.indexOf("The service is temporarily unavailable.") !== -1) {
                						this.log.warn("cannot reach " + url + " Server.");
                						resolve();
                						return;
                					}
                					if (body.indexOf("404 Not found") !== -1) {
                						this.log.warn("cannot reach " + url + " Server.");
                						resolve();
                						return;
                					}
                					if (body.indexOf("403 Forbidden") !== -1) {
                						this.log.warn("cannot reach " + url + " Server.");
                						resolve();
                						return;
                					}
									
                					try {
                						const obj = this.currentGefahren[areaCode].find(x => x.identifier === ref);
                						const index = this.currentGefahren[areaCode].indexOf(obj);
                						if (resp) {
                							this.etags[areaCode + url] = resp.headers.etag;
                							this.log.debug(resp.headers.etag + " " + url);
                							if (resp.statusCode === 304) {
                								this.log.debug("304 No values updated");
                								resolve();
                								return;
                							} else {
                								this.log.debug("Changed: " + url);
                								if (index !== -1) {
                									await this.resetWarnings(areaCode, index);
                								}
                							}
                						}

                						this.log.debug(body);
                						const gefahr = JSON.parse(body);
                						this.setState("info.connection", true, true);
                						if ( index === -1) {
                							this.currentGefahren[areaCode].push(gefahr);
                						} else {
                							this.currentGefahren[areaCode].splice(index, 1, gefahr);

                						}
                						resolve();
                					} catch (error) {
                						this.log.error(error + " " + JSON.stringify(error));
                						this.log.debug(body);
                						this.setState("info.connection", false, true);

                						resolve();
                						return;
                					}
                				}
                			);
                		});
                		promiseArray.push(requestPromise);
                	});
                });
			Promise.all(promiseArray)
				.then(() => {
					resolve();
				})
				.catch(() => {
					reject();
				});
		});
	}
	async resetWarnings(areaCode, index) {
		return new Promise(async (resolve, reject) => {
			let searchText = ".warnung";
			if (areaCode && index === undefined) {
				this.currentGefahren[areaCode] = [];
				Object.keys(this.etags).forEach(id => {
					if (id.startsWith(areaCode)) {
						delete this.etags[id];
					}
				});
				searchText = areaCode + searchText;
			}
			if (areaCode && index !== undefined) {
				let stringIndex = index + 1 + "";
				while (stringIndex.length < 2) stringIndex = "0" + stringIndex;
				searchText = areaCode + searchText + stringIndex;
			}
			const pre = this.name + "." + this.instance;
			const states = await this.getStatesAsync(pre + ".*");
			const allIds = Object.keys(states);
			const promiseArray = [];
			allIds.forEach(async keyName => {
				const promise = new Promise(async (resolve, reject) => {
					if (keyName.indexOf(searchText) !== -1) {
						await this.delObjectAsync(
							keyName
								.split(".")
								.slice(2)
								.join(".")
						);
					}
					
					resolve();
				});
				promiseArray.push(promise);
			});
			Promise.all(promiseArray).then(() => {
				resolve();
			});
			
		});
	}
	checkStatus(ags) {
		return new Promise(async (resolve, reject) => {
			if (ags === "Beispielwarnung") {
				this.status[ags] = {};
				this.status[ags].numberOfWarn = 1;
				this.status[ags].activeWarn = 1;
				this.status[ags].cancelWarn = 0;
				this.status[ags].identifierList = ["Beispiel"];
				resolve();
				return;
			}
			const headers = {};
			let agsNumber = ags.split("");
			const agsLength = agsNumber.length;
			agsNumber.length = 12;
			agsNumber.fill(0, agsLength, 12);
			agsNumber = agsNumber.join("");
			const url = "https://warnung.bund.de/bbk.status/status_" + agsNumber + ".json";
			if (this.etags[url]) {
				headers["If-None-Match"] = this.etags[url];
			}
			request.get(
				{
					url: url,
					followAllRedirects: true,
					headers: headers,
					gzip: true
				},
				(err, resp, body) => {
					if (err || (resp && resp.statusCode >= 400)) {
						if (err && err.code === "EPROTO") {
							this.log.warn(
								"You using a maybe modern TLS (debian Buster) which is not support by the NINA server. Please adjust in your /etc/ssl/openssl.cnf to CipherString = DEFAULT@SECLEVEL=1"
							);
						} else if (err && err.code === "ETIMEDOUT") {
							this.log.warn("Cannot reach " + url + " Server.");
						} else if (resp && resp.statusCode >= 400) {
							this.log.warn("Cannot reach " + url + " Server. Statuscode: " + resp.statusCode);
						}
						if (err) {
							this.log.error("Request error" + JSON.stringify(err));
						}
						reject();
						this.setState("info.connection", false, true);
						return;
					}
					try {
						if (resp) {
							this.etags[url] = resp.headers.etag;
							this.log.debug(resp.headers.etag + " " + url);
							if (resp.statusCode === 304) {
								this.log.debug("304 No Status values updated");
								reject();
								return;
							}
						}
						this.status[ags] = {};
						this.status[ags].numberOfWarn = 0;
						this.status[ags].activeWarn = 0;
						this.status[ags].cancelWarn = 0;
						this.status[ags].identifierList = [];
						this.status[ags].buckets = {};
						const status = JSON.parse(body);
						status.forEach(bucket => {
							this.status[ags].numberOfWarn += bucket.cancelCount;
							this.status[ags].numberOfWarn += bucket.activeCount;
							this.status[ags].cancelWarn += bucket.cancelCount;
							this.status[ags].activeWarn += bucket.activeCount;
							this.status[ags].identifierList = this.status[ags].identifierList.concat(bucket.ref);
							this.status[ags].buckets[bucket.bucketname] = bucket.ref;
						});
						resolve();
					} catch (error) {
						reject();
						return;
					}
				}
			);
		});
	}
	setGefahren() {
		return new Promise((resolve, reject) => {
			const adapter = this;
			Object.keys(this.status).forEach(areaCode => {
				this.setState(areaCode + ".numberOfWarn", this.status[areaCode].numberOfWarn, true);
				this.setState(areaCode + ".activeWarn", this.status[areaCode].activeWarn, true);
				this.setState(areaCode + ".cancelWarn", this.status[areaCode].cancelWarn, true);
				this.setState(areaCode + ".identifierList", { val: this.status[areaCode].identifierList, ack: true });
			});
			Object.keys(this.currentGefahren).forEach(areaCode => {
				this.currentGefahren[areaCode].forEach((element, index) => {
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
							if (!adapter.config.showArea && modPath.join(".").indexOf(".area") !== -1) {
								return;
							}
							adapter.setObjectNotExists(areaCode + ".warnung" + stringIndex + "." + modPath.join("."), {
								type: "state",
								common: {
									name: this.key,
									role: "indicator",
									type: typeof value,
									write: false,
									read: true
								},
								native: {}
							});
							adapter.setState(areaCode + ".warnung" + stringIndex + "." + modPath.join("."), value, true);
						}
					});
				});
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
