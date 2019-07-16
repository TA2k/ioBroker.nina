"use strict";

/*
 * Created with @iobroker/create-adapter v1.16.0
 */


const utils = require("@iobroker/adapter-core");
const request = require("request");
const traverse = require('traverse');

class Nina extends utils.Adapter {

	/**
	 * @param {Partial<ioBroker.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "nina",
		});
		this.on("ready", this.onReady.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("stateChange", this.onStateChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);
		this.agsArray = this.config.agsArray.replace(/ /g, '').split(",");
		request.get({
			url: "https://warnung.bund.de/assets/json/suche_channel.json",
			followAllRedirects: true
		}, (err, resp, body) => {
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
			});
		});
		this.interval = setInterval(() => {
			this.parseJSON();
		}, this.config.interval * 1000 * 60);

		// in this template all states changes inside the adapters namespace are subscribed
		//this.subscribeStates("*");


		// same thing, but the value is flagged "ack"
		// ack should be always set to true if the value is received from or acknowledged from the target system
		// await this.setStateAsync("testVariable", {
		// 	val: true,
		// 	ack: true
		// });
	}

	parseJSON() {
		return new Promise((resolve, reject) => {
			request.get({
				url: "https://warnung.bund.de/bbk.mowas/gefahrendurchsagen.json",
				followAllRedirects: true
			}, (err, resp, body) => {
				if (err) {
					this.log.error(JSON.stringify(err));
					reject();
				}
				try {
					this.log.debug(body);
					const gefahren = JSON.parse(body);
					const currentGefahren = {};
					gefahren.forEach(element => {
						element.info.forEach(infoElement => {
							infoElement.area.forEach(areaElement => {
								const trimmedAreaCode = areaElement.geocode.value.replace(new RegExp("[0]+$"), "");
								if (this.agsArray.indexOf(trimmedAreaCode) !== -1) {
									if (currentGefahren[trimmedAreaCode]) {
										currentGefahren[trimmedAreaCode].push(element);
									} else {
										currentGefahren[trimmedAreaCode] = [element];
									}
								}
							});

						});
					});
					this.setGefahren(currentGefahren);

				} catch (error) {
					this.log.error(JSON.stringify(error));
					reject();

				}
			});
		});
	}
	setGefahren(currentGefahren) {
		const adapter = this;
		Object.keys(currentGefahren).forEach(areaCode => {
			currentGefahren[areaCode].forEach((element, index) => {
				let stringIndex = index + "";
				while (stringIndex.length < 2) stringIndex = "0" + stringIndex;
				traverse(element).forEach(function (value) {

					adapter.setObjectNotExists(areaCode + ".warnung" + stringIndex + "." + this.path.join("."), {
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
					adapter.setState(areaCode + ".warnung" + stringIndex + "." + this.path.join("."), value, true);
				});
			});


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
	module.exports = (options) => new Nina(options);
} else {
	// otherwise start the instance directly
	new Nina();
}