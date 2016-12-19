'use strict';

var IrcClient = require('irc-framework').Client;

module.exports.create = createChannel;

function createChannel(session_id, channel_id) {
	let channel = {
		id: channel_id,
		session_id: session_id,
		upstream: null,
		ws: [],
		addWs: function addWs(ws) {
			if (channel.ws.indexOf(ws) === -1) {
				channel.ws.push(ws);
			}
		},
		removeWs: function removeWs(ws) {
			let idx = channel.ws.indexOf(ws);
			if (idx > -1) {
				channel.ws.splice(idx, 1);
			}
		},
		write: function write(line, ws) {
			// If a specific ws is not set, then write it to all ws clients
			ws = ws ? [ws] : channel.ws;
			console.log('Sending line to ' + ws.length + ' clients');
			ws.forEach(_ws => {
				let out = '';
				if (_ws.has_channel_support) {
					out = ':' + channel_id + ' ' + line;
				} else {
					out = line;
				}

				console.log('[to client]', out);
				_ws.write(out);
			});
		},
		writeStatus: function writeStatus(line, ws) {
			channel.write(':*status!bnc@kiwiirc NOTICE * :' + line, ws);
		},
		state: {
			network: {
				name: 'Network',
				motd: [],
				caps: [],
				// Any lines to be sent to the client on reconnect (eg. 001-004)
				registration_complete: [],
				// Any 005 lines
				support: [],
				buffer: {
					host: '',
					port: 6667,
					tls: false,
					password: '',
				},
				nick: '',
				mask: '',
			},
			buffers: new Map(),
			getBuffer: function getBuffer(buffer_name) {
				return channel.state.buffers.get(buffer_name.toLowerCase());
			},
			getOrCreateBuffer: function getOrCreateBuffer(buffer_name) {
				let normalised_name = buffer_name.toLowerCase();
				let buffer = channel.state.buffers.get(normalised_name);

				if (!buffer) {
					buffer = {
						name: buffer_name,
						joined: false
					};
					channel.state.buffers.set(normalised_name, buffer);
				}

				return buffer;
			},
			removeBuffer: function removeBuffer(buffer_name) {
				channel.state.buffers.delete(buffer_name.toLowerCase());
			}
		},
		connectIfReady: function connectIfReady() {
			// Already created an IRCd connection? Don't do it again
			if (channel.isUpstreamConnected()) {
				console.log('connectIfReady() Upstream already connected');
				return;
			}

			let buffer = channel.state.network.buffer;
			if (buffer.host && buffer.port && buffer.nick && buffer.username) {
				let connect_args = {
					host: buffer.host,
					port: buffer.port,
					password: buffer.password,
					nick: buffer.nick,
					tls: buffer.tls,
				};
				console.log(connect_args);

				let client = channel.upstream;
				if (!client) {
					console.log('Creating upstream');
					client = channel.upstream = new IrcClient();
					client.use(clientMiddleware(channel));
				} else {
					console.log('Reusing upstream');
				}

				client.connect(connect_args);

				return true;
			} else {
				console.log('Not ready to create upstream');
			}
		},
		isUpstreamConnected: function isUpstreamConnected() {
			return (
				channel.upstream &&
				channel.upstream.connection &&
				channel.upstream.connection.connected
			);
		},
	};

	return channel;
}






function clientMiddleware(channel) {
	return function(client, raw, parsed) {
		raw.use(rawMiddleware);

		client.on('raw socket connected', () => {
			client.is_sock_connected = true;
			channel.write('CONTROL CONNECTED');
		});

		client.on('socket close', () => {
			console.log('IRCd connection closed');
			client.is_sock_connected = false;
			client.has_registered = false;
			channel.state.network.registration_complete = [];
			channel.writeStatus(`Disconnected from ${channel.state.network.buffer.host}`);
			channel.write('CONTROL CLOSED');
		});

		client.on('connected', () => {
			client.has_registered = true;
			channel.writeStatus(`Now connected to ${channel.state.network.buffer.host}!`);
		});
	};

	function rawMiddleware(command, message, raw, client, next) {
		// The clients and kiwi server ping amongst themselves
		if (message.command === 'PING') {
			channel.upstream.raw('PONG ' + message.params[0]);
			return;
		}
		if (message.command === 'PONG') {
			return next();
		}
		if (message.command === 'CAP') {
			// irc-framework handles this for us
			return next();
		}

		// Some lines on registration to be stored so they can be replayed to clients
		let on_registered_numerics = [
			'001',
			'002',
			'003',
			'004',
		];
		if (on_registered_numerics.indexOf(command) > -1) {
			channel.state.network.registration_complete.push(message);
		}

		if (command === '001') {
			console.log('Setting state nick to', message.params[0]);
			channel.state.network.nick = message.params[0];
		}

		// RPL_ISUPPORT lines
		if (command === '005') {
			channel.state.network.support.push(message);
			(message.params || []).forEach(param => {
				if (param.indexOf('NETWORK=') === 0) {
					let net_name = param.split('=')[1];
					if (net_name) {
						channel.state.network.name = net_name;
					}
				}
			});
		}

		// MOTD lines
		let motd_events = [
			'375',
			'372',
			'376'
		];
		if (motd_events.indexOf(command) > -1) {
			channel.state.network.motd.push(message);
		}


		let is_us = (message.nick || '').toLowerCase() === (client.user.nick || '').toLowerCase();

		if (is_us && command === 'NICK') {
			console.log('Setting state nick to', message.params[0]);
			channel.state.network.nick = message.params[0];
		}

		if (is_us && command === 'JOIN') {
			channel.state.network.mask = message.prefix;
			let chan_name = message.params[0];
			console.log('Joined', chan_name);
			let buffer = channel.state.getOrCreateBuffer(chan_name);
			buffer.joined = true;
		}

		if (is_us && (command === 'PART' || command === 'KICK')) {
			let chan_name = message.params[0];
			console.log('Left', chan_name);
			let buffer = channel.state.getBuffer(chan_name);
			if (buffer) {
				buffer.joined = false;
			}
		}
		//if (!client.has_registered) {
		//	return next();
		//}

		// Pass the line down to connected clients
		channel.write(raw);
		next();
	}
}