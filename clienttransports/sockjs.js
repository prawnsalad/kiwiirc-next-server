var http = require('http');
var sockjs = require('sockjs');

module.exports.startAcceptingClients = function(fn) {
	var echo = sockjs.createServer({ sockjs_url: 'http://cdn.jsdelivr.net/sockjs/1.0.1/sockjs.min.js' });
	echo.on('connection', socket => {
		socket.has_channel_support = true;
		fn(socket);
	});

	var server = http.createServer();
	echo.installHandlers(server, {prefix:'/webirc'});
	server.listen(8081, '0.0.0.0');
};
