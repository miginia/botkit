const caps = require('node-xmpp-caps');
const Stanza = require('node-xmpp-client').Stanza;
const MD5 = require('md5');

function JabberGroupManager(config, xmpp, bot, controller) {
    var group_manager = {
        config: config || {},
    };

    var joinedRoomsPasswordMap = new Map();
    var joinedPersistRoomsId = new Set();
    var joinedRoomsId = new Set();

    const bot_caps_node_addr = 'http://protocols.cisco.com/jabber-bot';
    var bot_caps = createCapsNode(bot_caps_node_addr);

    xmpp.on('online', function(data) {
        publishCapabilities();
        joinPresetRooms();
    });

    xmpp.on('stanza', function(stanza) {
        if (stanza.is('iq')) {
            handleCapabilityIq(stanza);
            handleRoomDiscoQueryIq(stanza);
        } else if (stanza.is('message')) {
            handleInviteMessage(stanza);
        } else if (stanza.is('presence')) {
            handleMembershipPresence(stanza);
        }
    });

    function createCapsNode(caps_node_addr) {
        var bot_caps = new caps.Caps(caps_node_addr);
        bot_caps.addIdentity('client', 'bot', 'Cisco Jabber Bot');
        bot_caps.addFeature('http://jabber.org/protocol/caps');
        bot_caps.addFeature('http://jabber.org/protocol/disco#info');
        bot_caps.addFeature('http://jabber.org/protocol/disco#items');
        bot_caps.addFeature('http://jabber.org/protocol/muc');
        return bot_caps;
    };

    function publishCapabilities() {
        let presence_stanza = new Stanza('presence');
        presence_stanza.cnode(bot_caps.toCapsNode());
        xmpp.conn.send(presence_stanza);
    };

    function joinPresetRooms() {
        if (config.group && config.group.rooms) {
            for (let i = 0; i < config.group.rooms.length; i++) {
                let room_id = config.group.rooms[i].id;
                let password = config.group.rooms[i].password;
                if (!joinedRoomsId.has(getBareRoomId(room_id))) {
                    joinedRoomsPasswordMap.set(getBareRoomId(room_id), password);
                    xmpp.join(room_id, password);
                }
            }
        }

        controller.storage.teams.all(function(err, rooms) {
            for (let i = 0; i < rooms.length; i++) {
                let room = rooms[i];
                if (room.type === 'joined_persist_rooms') {
                    let room_id = room.room_id + '/' + bot.client_jid;
                    let password = room.password;
                    if (!joinedRoomsId.has(getBareRoomId(room_id))) {
                        joinedRoomsPasswordMap.set(getBareRoomId(room_id), password);
                        xmpp.join(room_id, password);
                    }
                }
            }
        });
    };

    function handleCapabilityIq(stanza) {
        if (stanza.type === 'get') {
            let query = stanza.getChild('query', 'http://jabber.org/protocol/disco#info');
            if (query) {
                let caps_node = query.attrs.node;
                if (caps_node) {
                    let caps_node_addr = caps_node.split('#')[0];
                    if (bot_caps_node_addr == caps_node_addr) {
                        let from = stanza.attrs.from;
                        let to = stanza.attrs.to;
                        let result = bot_caps.toQueryNode();
                        let disco_id = stanza.id ? stanza.id : 'disco1';
                        let iq_stanza = new Stanza('iq', { 'id': disco_id, 'type': 'result', 'to': from, 'from': to });
                        iq_stanza.cnode(bot_caps.toQueryNode());
                        xmpp.conn.send(iq_stanza);
                    }
                }
            }
        }
    };

    function handleRoomDiscoQueryIq(stanza) {
        if (stanza.attrs.type !== 'result')
            return;
        if (stanza.attrs.id !== 'room_disco1')
            return;
        let jid = stanza.attrs.to;
        if (!jid)
            return;
        let bareJid = jid.split('/')[0];
        if (bareJid !== bot.client_jid)
            return;

        let query = stanza.getChild('query', 'http://jabber.org/protocol/disco#info');
        if (!query)
            return;

        let room_id = stanza.attrs.from;
        if (!room_id)
            return;

        let features = query.getChildren('feature');
        for (let i = 0; i < features.length; i++) {
            let feature = features[i];
            if (feature.attrs.var === 'persistent' ||
                feature.attrs.var === 'muc_persistent') {
                joinedPersistRoomsId.add(getBareRoomId(room_id));
                let password = joinedRoomsPasswordMap.get(getBareRoomId(room_id));
                saveJoinPersistRooms(getBareRoomId(room_id), password);
                return;
            }
        }
    };

    function handleInviteMessage(stanza) {
        let muc_message = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
        if (!muc_message)
            return;

        let invite_node = muc_message.getChild('invite');
        if (!invite_node)
            return;

        let password = undefined;
        let password_node = muc_message.getChild('password');
        if (password_node)
            password = password_node.getText();
        let room_id = stanza.attrs.from + '/' + bot.client_jid;

        if (!joinedRoomsId.has(getBareRoomId(room_id))) {
            joinedRoomsPasswordMap.set(getBareRoomId(room_id), password);
            xmpp.join(room_id, password);
        }
    };

    function handleMembershipPresence(stanza) {
        let group_type = stanza.getChild('x', 'http://jabber.org/protocol/muc#user');
        if (!group_type)
            return;

        let item = group_type.getChild('item');
        if (!item)
            return;

        let jid = item.attrs.jid;
        if (!jid)
            return;
        let bareJid = jid.split('/')[0];
        if (bareJid !== bot.client_jid)
            return;

        let room_id = stanza.attrs.from;
        if (item.attrs.role === 'none') {
            let status = group_type.getChild('status');
            if (status && (status.attrs.code === '321' || status.attrs.code === '307')) {
                joinedRoomsId.delete(getBareRoomId(room_id));
                joinedRoomsPasswordMap.delete(getBareRoomId(room_id));
                if (joinedPersistRoomsId.has(getBareRoomId(room_id))) {
                    joinedPersistRoomsId.delete(getBareRoomId(room_id));
                    saveLeavePersistRooms(getBareRoomId(room_id));
                }
            }
        } else if (item.attrs.role === 'participant') {
            joinedRoomsId.add(getBareRoomId(room_id));

            sendRoomDiscoQueryIq(room_id, jid);
        }
    };

    function sendRoomDiscoQueryIq(room_id, jid) {
        let from = jid;
        let to = room_id.split('/')[0];
        let disco_id = 'room_disco1';
        let node = to.split('@')[1];
        let iq_stanza = new Stanza('iq', { 'id': disco_id, 'type': 'get', 'to': to, 'from': from });
        iq_stanza.c('query', { xmlns: 'http://jabber.org/protocol/disco#info', 'node': node});
        xmpp.conn.send(iq_stanza);
    };

    function saveJoinPersistRooms(room_id, room_password) {
        let id = MD5(room_id);
        controller.storage.teams.get(id, function(err, room) {
            if (!room) {
                room = {
                    id: id,
                };
            }
            room.room_id = room_id;
            room.password = room_password;
            room.type = 'joined_persist_rooms';
            controller.storage.teams.save(room, function(err, room) {
            });
        });
    }

    function saveLeavePersistRooms(room_id) {
        let id = MD5(room_id);
        controller.storage.teams.delete(id, function(err, room) {
        });
    }

    function getBareRoomId(room_id) {
        return room_id.split('/')[0];
    }
}

module.exports = JabberGroupManager;
