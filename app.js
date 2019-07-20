"use strict";

const ssdp = require('node-ssdp').Client,
      upnp = require('node-upnp'),
      net  = require('net'),
      url  = require('url')
      ;

const ssdpclient = new ssdp();
let remotes = {};

function Remote(upnp) {
//    console.log(upnp);
    this.getVolume = async () => {
        return (await upnp.call('RenderingControl', 'GetVolume', {
                    InstanceID: 0,
                    Channel: 'Master'
                })).CurrentVolume;
    };
    this.getMute = async () => {
        return (await upnp.call('RenderingControl', 'GetMute', {
                    InstanceID: 0,
                    Channel: 'Master'
                })).CurrentMute;
    };
    this.setVolume = async (v) => {
        return (await upnp.call('RenderingControl', 'SetVolume', {
                    InstanceID: 0,
                    Channel: 'Master',
                    DesiredVolume: v
                })).CurrentVolume;
    };
    this.setMute = async (v) => {
        return (await upnp.call('RenderingControl', 'SetMute', {
                    InstanceID: 0,
                    Channel: 'Master',
                    DesiredMute: v ? 1 : 0
                })).CurrentMute;
    };
}

function Discover(cb) {
    ssdpclient.on('response', async function inResponse(headers, code, rinfo) {
        if (headers.ST == "urn:schemas-upnp-org:service:RenderingControl:2") {
            if (remotes[headers.USN]) return;

            let u = new upnp({ url: headers.LOCATION });
            let remote = remotes[headers.USN] = new Remote(u);

            let desc = await u.getDeviceDescription();

            if (desc) {
//                console.log("found", desc.UDN, desc.friendlyName,
//                            desc.manufacturer,
//                            desc.modelName,
//                            desc.modelNumber);

                if (desc.manufacturer == "Devialet" && desc.modelName == "Devialet UPnP Renderer") {
                    remote.id = desc.UDN;
                    remote.name = desc.friendlyName;
                    cb(remote, 'connected');

                    const loc = url.parse(headers.LOCATION);
                    function ping() {
                        let socket = new net.Socket();
                        socket.setTimeout(5000);
                        socket.on("timeout", () => {
                            if (socket) {
//                                console.log("pinger", "timeout");
                                socket.destroy();
                                socket = undefined;
                                cb(remote, 'disconnected');
                            }
                        });
                        socket.on("error", err => {
                            if (socket) {
//                                console.log("pinger", "error");
                                socket.destroy();
                                socket = undefined;
                                cb(remote, 'disconnected');
                            }
                        });

                        socket.connect(loc.port, loc.hostname, () => {
                            if (socket) {
//                                console.log("pinger", "connected");
                                socket.destroy();
                                setTimeout(function() { ping(); }, 5000)
                            }
                        });
                    }
                    setTimeout(function() { ping(); }, 5000)
                }
            }

            // My ancient Phantom (the chrome one) does not support this, so I'm giving
            // gup on events coming from Spark/PhantomKnob
//            await u.subscribe('RenderingControl', function (a) {
//                console.log('XXX', arguments);
//            });
        }
    })

    function search() {
        ssdpclient.search('urn:schemas-upnp-org:service:RenderingControl:2');
        setTimeout(function() { search(); }, 10000)
    }

    search();
}

//    console.log("Searching for Devialet Bridge...") 

var RoonApi              = require("node-roon-api"),
    RoonApiStatus        = require('node-roon-api-status'),
    RoonApiVolumeControl = require('node-roon-api-volume-control');

var roon = new RoonApi({
    extension_id:        'com.roonlabs.devialet.phantom.volume',
    display_name:        'Devialet Phantom Volume Control',
    display_version:     "1.0.0",
    publisher:           'Roon Labs, LLC',
    email:               'contact@roonlabs.com',
    website:             'https://github.com/RoonLabs/roon-extension-devialet-phantom-volume',
});

let devices = 0;
var svc_status = new RoonApiStatus(roon);
var svc_volume_control = new RoonApiVolumeControl(roon);

roon.init_services({
    provided_services: [ svc_volume_control, svc_status ]
});

function setup() {
    new Discover((r, what) => {
        if (r.volume_control) { r.volume_control.destroy(); delete(r.volume_control); }
//        console.log(r, what);
        if (what == "connected")
            ev_connected(r);
        else
            ev_disconnected(r);
    });

    svc_status.set_status("Searching...", false);
}

async function ev_connected(r) {
    devices++;
    svc_status.set_status(`Found ${devices} ${devices == 1 ? "device" : "devices"}`, false);

    console.log(r.id);
    r.volume_control = svc_volume_control.new_device({
	state: {
            control_key:  r.id,
	    display_name: `${r.name}`,
	    volume_type:  "number",
	    volume_min:   1,
	    volume_max:   100,
	    volume_value: await r.getVolume(),
	    volume_step:  1.0,
	    is_muted:     await r.getMute()
	},
	set_volume: async function (req, mode, value) {
	    let newvol = mode == "absolute" ? value : ((await r.getVolume()) + value);
	    if      (newvol < this.state.volume_min) newvol = this.state.volume_min;
	    else if (newvol > this.state.volume_max) newvol = this.state.volume_max;
            await r.setVolume(newvol);
            ev_volume(r, newvol);
            req.send_complete("Success");
	},
	set_mute: async function (req, action) {
            let mute = action == 'on';
            if (action == 'toggle')
                mute = !(await r.getMute());
            r.setMute(mute);
            ev_mute(r, mute);
	    req.send_complete("Success");
	}
    });
}

function ev_disconnected(r) {
    devices--;
    if (devices == 0) {
        svc_status.set_status("Searching...", false);
    } else {
        svc_status.set_status(`Found ${devices} ${devices == 1 ? "device" : "devices"}`, false);
    }

    if (r.volume_control) { r.volume_control.destroy(); delete(r.volume_control);   }
}

function ev_volume(r, val) {
//    console.log("[Devialet Phantom Volume Extension] received volume change from device:", val);
    if (r.volume_control)
        r.volume_control.update_state({ volume_value: val });
}
function ev_mute(r, val) {
//    console.log("[Devialet Phantom Volume Extension] received volume change from device:", val);
    if (r.volume_control)
        r.volume_control.update_state({ is_muted: val });
}

setup();

roon.start_discovery();
