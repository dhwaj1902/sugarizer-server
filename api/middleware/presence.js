// websocket and http servers
var webSocket = require('ws');
var http = require('http');
var https = require('https');
var common = require('../../dashboard/helper/common');

exports.init = function(settings, httpserver, app) {
	/**
	 * Global variables
	 */
	// List of currently connected clients (users)
	var clients = [];

	// Http server
	var server = httpserver;

	// List of shared activities
	var sharedActivities = [];

	/**
	 * Message types
	 */
	/* eslint-disable no-unused-vars */
	var msgInit = 0;
	var msgListUsers = 1;
	var msgCreateSharedActivity = 2;
	var msgListSharedActivities = 3;
	var msgJoinSharedActivity = 4;
	var msgLeaveSharedActivity = 5;
	var msgOnConnectionClosed = 6;
	var msgOnSharedActivityUserChanged = 7;
	var msgSendMessage = 8;
	var msgListSharedActivityUsers = 9;
	var closedBecauseDuplicate = 4999;
	/* eslint-enable no-unused-vars */

	/**
	 * HTTP server
	 */
	if (settings.presence.port != settings.web.port) {
		// Not on the same port: create a new one
		if (settings.security.https) {
			var credentials = common.loadCredentials(settings);
			if (!credentials) {
				console.log("Error reading HTTPS credentials");
				process.exit(-1);
			}
			server = https.createServer(credentials);
		} else {
			server = http.createServer();
		}
		server.listen(settings.presence.port, function() {
			console.log("Presence is listening on"+(settings.security.https ? " secure":"")+" port " + settings.presence.port + "...");
		}).on('error', function(err) {
			console.log("Ooops! cannot launch presence on port "+ settings.presence.port + ", error code "+err.code);
			process.exit(-1);
		});
	} else {
		// Use the existing HTTP server
		console.log("Presence is listening on"+(settings.security.https ? " secure":"")+" port " + settings.presence.port + "...");
	}

	// Log message
	var level = settings.log?settings.log.level:1;
	var logmessage = function(buffer) {
		if (level != 0) {
			console.log(buffer);
		}
	};

	/**
	 * WebSocket server
	 */
	const wsServer = new webSocket.Server({
		server: server,
		maxPayload: 44040192
	});

	// Callback function called every time someone connect to the WebSocket server
	wsServer.on('connection', function(connection) {
		// Add client to array, wait for userId
		var userIndex;
		var userId = false;

		// An user sent some message
		connection.on('message', function(message) {
			// First message sent is user settings
			if (userId === false) {
				// Get user settings
				var rjson = JSON.parse(message);

				// Forbid user arlready connected on another device
				if ((userIndex = findClient(rjson.networkId)) != -1) {
					// Disconnect user on other device
					clients[userIndex].connection.close(closedBecauseDuplicate);

					// Reset user
					clients[userIndex].settings = rjson;
					clients[userIndex].connection = connection;
					userId = rjson.networkId;
					logmessage('User ' + userId + ' already connected, closed previous connection and reconnect it');
				} else {
					// Add client
					userIndex = addClient(connection);
					clients[userIndex].settings = rjson;

					// Get user name
					userId = rjson.networkId;
					logmessage('User ' + userId + ' join the network');
				}
			} else {
				// Get message content
				var rjson = JSON.parse(message);

				// Process message depending of this type
				switch (rjson.type) {
				// MESSAGE: listUsers
				case msgListUsers:
				{
					// Compute connected user list
					var connectedUsers = [];
					for (var i = 0; i < clients.length; i++) {
						if (clients[i] != null) {
							connectedUsers.push(clients[i].settings);
						}
					}

					// Send the list
					connection.send(JSON.stringify({
						type: msgListUsers,
						data: connectedUsers
					}));
					break;
				}

				// MESSAGE: createSharedActivity
				case msgCreateSharedActivity:
				{
					// Create shared activities
					var activityId = rjson.activityId;
					var groupId = createSharedActivity(activityId, userId);
					logmessage('Shared group ' + groupId + " (" + activityId + ") created");

					// Add user into group
					addUserIntoGroup(groupId, userId);

					// Send the group id
					connection.send(JSON.stringify({
						type: msgCreateSharedActivity,
						data: groupId
					}));
					break;
				}

				// MESSAGE: listSharedActivities
				case msgListSharedActivities:
				{
					// Compute shared activities list
					var listShared = [];
					for (var i = 0; i < sharedActivities.length; i++) {
						if (sharedActivities[i] != null) {
							listShared.push(sharedActivities[i]);
						}
					}

					// Send the list
					connection.send(JSON.stringify({
						type: msgListSharedActivities,
						data: listShared
					}));
					break;
				}

				// MESSAGE: joinSharedActivity
				case msgJoinSharedActivity:
				{
					// Update group
					var groupId = rjson.group;
					var groupProperties = addUserIntoGroup(groupId, userId);

					// Send the group properties
					connection.send(JSON.stringify({
						type: msgJoinSharedActivity,
						data: groupProperties
					}));
					break;
				}

				// MESSAGE: leaveSharedActivity
				case msgLeaveSharedActivity:
				{
					// Update group
					var groupId = rjson.group;
					removeUserFromGroup(groupId, userId);
					break;
				}

				// MESSAGE: listSharedActivityUsers
				case msgListSharedActivityUsers:
				{
					// Get group
					var groupId = rjson.group;

					// Compute connected user list
					var connectedUsers = listUsersFromGroup(groupId);
					var usersList = [];
					for (var i = 0; i < connectedUsers.length; i++) {
						var j = findClient(connectedUsers[i]);
						if (j != -1) {
							usersList.push(clients[j].settings);
						}
					}

					// Send the list
					connection.send(JSON.stringify({
						type: msgListSharedActivityUsers,
						data: usersList
					}));
					break;
				}

				// MESSAGE: sendMessage
				case msgSendMessage:
				{
					// Get arguments
					var groupId = rjson.group;
					var data = rjson.data;

					// Send the group properties
					var message = {
						type: msgSendMessage,
						data: data
					};
					broadcastToGroup(groupId, message);
					break;
				}

				default:
					console.log("Unrecognized received json type");
					break;
				}
			}
		});

		// user disconnected
		connection.on('close', function(reason) {
			if (userId !== false) {
				if (reason == closedBecauseDuplicate) {
					logmessage("User " + userId + " disconnected automatically");
				} else {
					logmessage("User " + userId + " disconnected");
					removeClient(userIndex);
				}
			}
		});

	});


	/**
	 * Utility functions
	 */

	// Create a uuid
	function createUUID() {
		var s = [];
		var hexDigits = "0123456789abcdef";
		for (var i = 0; i < 36; i++) {
			s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
		}
		s[14] = "4";
		s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1);
		s[8] = s[13] = s[18] = s[23] = "-";

		var uuid = s.join("");
		return uuid;
	}

	// Find client by id
	function findClient(userId) {
		for (var i = 0; i < clients.length; i++) {
			if (clients[i] != null && clients[i].settings.networkId == userId)
				return i;
		}
		return -1;
	}

	// Add a new client in the client array
	function addClient(connection) {
		// Create client
		var client = {
			connection: connection
		};

		// Find a free space in array
		for (var i = 0; i < clients.length; i++) {
			// Found, use it to store user
			if (clients[i] == null) {
				clients[i] = client;
				return i;
			}
		}

		// Not found, increase array to store user
		return clients.push(client) - 1;
	}

	// Remove a client from the client array
	function removeClient(index) {
		// Iterate on each shared activities
		if (!clients[index])
			return;
		var userId = clients[index].settings.networkId;
		for (var i = 0; i < sharedActivities.length; i++) {
			if (sharedActivities[i] == null)
				continue;

			// Remove user from group
			removeUserFromGroup(sharedActivities[i].id, userId);
		}

		// Clean array
		clients[index] = null;
	}

	// Create a new shared activity
	function createSharedActivity(activityId, user) {
		// Create a new group
		var group = {
			id: createUUID(),
			activityId: activityId,
			users: []
		};

		// Find a free space in array
		for (var i = 0; i < sharedActivities.length; i++) {
			// Found, use it to store group
			if (sharedActivities[i] == null) {
				sharedActivities[i] = group;
				break;
			}
		}
		if (i >= sharedActivities.length) {
			// Not found, increase array size
			sharedActivities.push(group);
		}

		// Fill activity color with user color
		var userIndex = findClient(user);
		if (userIndex != -1 && clients[userIndex]) {
			group.colorvalue = clients[userIndex].settings.colorvalue;
		}

		return group.id;
	}

	// Find a group by Id
	function findGroup(groupId) {
		for (var i = 0; i < sharedActivities.length; i++) {
			// Found, use it to store group
			if (sharedActivities[i] == null)
				continue;
			if (sharedActivities[i].id == groupId)
				return i;
		}
		return -1;
	}

	// Add user into a group id
	function addUserIntoGroup(groupId, userId) {
		// Find the group
		var groupIndex = findGroup(groupId);
		if (groupIndex == -1)
			return null;

		// Add the user in group if not already there
		var usersInGroup = sharedActivities[groupIndex].users;
		var foundUser = false;
		for (var j = 0; j < usersInGroup.length; j++) {
			// Check if client is in the group
			if (usersInGroup[j] == userId) {
				foundUser = true;
				break;
			}
		}
		if (!foundUser) {
			sharedActivities[groupIndex].users.push(userId);
			logmessage('User ' + userId + ' join group ' + groupId);
			var userIndex = findClient(userId);
			var message = {
				type: msgOnSharedActivityUserChanged,
				data: {
					user: clients[userIndex].settings,
					move: +1
				}
			};
			broadcastToGroup(groupId, message);
		}

		// Return group properties
		return sharedActivities[groupIndex];
	}

	// Remove an user from a group id
	function removeUserFromGroup(groupId, userId) {
		// Find the group
		var groupIndex = findGroup(groupId);
		if (groupIndex == -1)
			return null;

		// Remove the userId
		var usersInGroup = sharedActivities[groupIndex].users;
		var newUsersInGroup = [];
		for (var j = 0; j < usersInGroup.length; j++) {
			// Check if client is in the group
			var currentUser = usersInGroup[j];
			if (currentUser != userId)
				newUsersInGroup.push(currentUser);
			else {
				logmessage('User ' + userId + ' leave group ' + groupId);
				var userIndex = findClient(userId);
				var message = {
					type: msgOnSharedActivityUserChanged,
					data: {
						user: clients[userIndex].settings,
						move: -1
					}
				};
				broadcastToGroup(groupId, message);
			}
		}

		// If the group is now empty, remove it
		sharedActivities[groupIndex].users = newUsersInGroup;
		if (newUsersInGroup.length == 0) {
			logmessage('Shared group ' + groupId + " removed");
			sharedActivities[groupIndex] = null;
		}
	}

	// Broadcast a message to all group member
	function broadcastToGroup(groupId, json) {
		// Find the group
		var groupIndex = findGroup(groupId);
		if (groupIndex == -1)
			return;

		// For each user in the group
		var usersInGroup = sharedActivities[groupIndex].users;
		for (var j = 0; j < usersInGroup.length; j++) {
			// Get client
			var clientIndex = findClient(usersInGroup[j]);
			if (clientIndex == -1)
				return;

			// Send message
			var connection = clients[clientIndex].connection;
			connection.send(JSON.stringify(json));
		}
	}

	// List users for a group
	function listUsersFromGroup(groupId) {
		// Find the group
		var groupIndex = findGroup(groupId);
		if (groupIndex == -1)
			return [];

		// Return users in group
		return sharedActivities[groupIndex].users;
	}
};
