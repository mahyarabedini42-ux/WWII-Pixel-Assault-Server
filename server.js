const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const MAX_PLAYERS = 4;

const clients = new Map();
const rooms = new Map();

let nextId = 1;

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon"
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
    res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store"
    });
    res.end(body);
}

const server = http.createServer((req, res) => {
    let urlPath;

    try {
        urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
        return send(res, 400, "Bad Request");
    }

    if (urlPath === "/") {
        urlPath = "/index.html";
    }

    if (urlPath.includes("..")) {
        return send(res, 400, "Bad Request");
    }

    const filePath = path.join(__dirname, urlPath);

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            return send(res, 404, "Not found");
        }

        const ext = path.extname(filePath).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";

        res.writeHead(200, {
            "Content-Type": type,
            "Cache-Control": "no-store"
        });

        fs.createReadStream(filePath).pipe(res);
    });
});

const wss = new WebSocket.Server({
    server,
    maxPayload: 256 * 1024
});

function safeSend(client, data) {
    if (
        client &&
        client.ws &&
        client.ws.readyState === WebSocket.OPEN
    ) {
        client.ws.send(JSON.stringify(data));
    }
}

function cleanName(name) {
    return String(name || "")
        .trim()
        .replace(/[^\p{L}\p{N}_ -]/gu, "")
        .slice(0, 16);
}

function makeRoomCode() {
    let code;

    do {
        code = String(
            Math.floor(100000 + Math.random() * 900000)
        );
    } while (rooms.has(code));

    return code;
}

function getRoomPlayers(room) {
    const players = {};

    for (const id of room.players) {
        const client = clients.get(id);

        if (client && client.player) {
            players[id] = {
                ...client.player,
                id,
                name: client.name,
                host: id === room.host
            };
        }
    }

    return players;
}

function broadcastRoom(room, message, exceptId = null) {
    const data = JSON.stringify(message);

    for (const id of room.players) {
        if (id === exceptId) continue;

        const client = clients.get(id);

        if (
            client &&
            client.ws.readyState === WebSocket.OPEN
        ) {
            client.ws.send(data);
        }
    }
}

function broadcastRoomIncludingSender(room, message) {
    const data = JSON.stringify(message);

    for (const id of room.players) {
        const client = clients.get(id);

        if (
            client &&
            client.ws.readyState === WebSocket.OPEN
        ) {
            client.ws.send(data);
        }
    }
}

function sendRoomUpdate(room) {
    broadcastRoomIncludingSender(room, {
        type: "room",
        code: room.code,
        host: room.host,
        players: getRoomPlayers(room),
        started: room.started,
        stage: room.stage
    });
}

function nameTaken(room, name, exceptId = null) {
    const wanted = name.toLowerCase();

    for (const id of room.players) {
        if (id === exceptId) continue;

        const client = clients.get(id);

        if (
            client &&
            client.name &&
            client.name.toLowerCase() === wanted
        ) {
            return true;
        }
    }

    return false;
}

function leaveRoom(client) {
    if (!client.room) return;

    const room = rooms.get(client.room);

    client.room = null;

    if (!room) return;

    room.players.delete(client.id);

    if (room.host === client.id) {
        const nextHost = room.players.values().next().value || null;
        room.host = nextHost;
    }

    if (room.players.size === 0) {
        rooms.delete(room.code);
        return;
    }

    if (room.started) {
        room.started = false;
    }

    sendRoomUpdate(room);
}

wss.on("connection", ws => {

    if (clients.size >= 100) {
        ws.close(1013, "Server is full");
        return;
    }

    const id = String(nextId++);

    const client = {
        ws,
        id,
        name: "",
        room: null,
        player: null
    };

    clients.set(id, client);

    safeSend(client, {
        type: "connected",
        id
    });

    ws.on("message", raw => {

        let message;

        try {
            message = JSON.parse(raw.toString());
        } catch {
            return;
        }

        if (!message || typeof message.type !== "string") {
            return;
        }

        /* =========================
           HELLO
        ========================= */

        if (message.type === "hello") {

            const name = cleanName(message.name);

            if (name.length < 2) {
                return safeSend(client, {
                    type: "error",
                    message: "نام باید حداقل ۲ حرف باشد."
                });
            }

            client.name = name;

            client.player = {
                id,
                name,
                x: 120,
                y: 420,
                dir: 1,
                hp: 100,
                gun: "rifle",
                stage: 1,
                alive: true
            };

            return safeSend(client, {
                type: "welcome",
                id
            });
        }

        if (!client.name) return;

        /* =========================
           CREATE ROOM
        ========================= */

        if (message.type === "create_room") {

            leaveRoom(client);

            const code = makeRoomCode();

            const room = {
                code,
                host: client.id,
                players: new Set([client.id]),
                started: false,
                stage: 1
            };

            rooms.set(code, room);

            client.room = code;

            return safeSend(client, {
                type: "room_created",
                code,
                host: true,
                started: false,
                stage: 1,
                players: getRoomPlayers(room)
            });
        }

        /* =========================
           JOIN ROOM
        ========================= */

        if (message.type === "join_room") {

            const code = String(message.code || "")
                .replace(/\D/g, "");

            if (!/^\d{6}$/.test(code)) {
                return safeSend(client, {
                    type: "error",
                    message: "رمز اتاق باید دقیقاً ۶ رقمی باشد."
                });
            }

            const room = rooms.get(code);

            if (!room) {
                return safeSend(client, {
                    type: "error",
                    message: "این اتاق پیدا نشد."
                });
            }

            if (room.players.size >= MAX_PLAYERS) {
                return safeSend(client, {
                    type: "error",
                    message: "این اتاق پر است؛ حداکثر ۴ نفر."
                });
            }

            if (room.started) {
                return safeSend(client, {
                    type: "error",
                    message: "بازی این اتاق شروع شده است."
                });
            }

            if (nameTaken(room, client.name, client.id)) {
                return safeSend(client, {
                    type: "error",
                    message: "این نام در اتاق قبلاً استفاده شده است."
                });
            }

            leaveRoom(client);

            room.players.add(client.id);
            client.room = code;

            safeSend(client, {
                type: "room_joined",
                code,
                host: client.id === room.host,
                started: room.started,
                stage: room.stage,
                players: getRoomPlayers(room)
            });

            sendRoomUpdate(room);

            return;
        }

        /* =========================
           LEAVE ROOM
        ========================= */

        if (message.type === "leave_room") {

            leaveRoom(client);

            return safeSend(client, {
                type: "left_room"
            });
        }

        if (!client.room) return;

        const room = rooms.get(client.room);

        if (!room) return;

        /* =========================
           START GAME
        ========================= */

        if (message.type === "start_game") {

            if (client.id !== room.host) {
                return safeSend(client, {
                    type: "error",
                    message: "فقط میزبان می‌تواند بازی را شروع کند."
                });
            }

            if (room.players.size < 1) {
                return;
            }

            const stage = Math.max(
                1,
                Math.min(
                    5,
                    Number(message.stage) || 1
                )
            );

            room.started = true;
            room.stage = stage;

            for (const playerId of room.players) {

                const playerClient = clients.get(playerId);

                if (playerClient && playerClient.player) {

                    playerClient.player.stage = stage;
                    playerClient.player.x = 120;
                    playerClient.player.y = 420;
                    playerClient.player.hp = 100;
                    playerClient.player.alive = true;
                }
            }

            return broadcastRoomIncludingSender(room, {
                type: "start_game",
                stage
            });
        }

        /* =========================
           RETURN TO LOBBY
        ========================= */

        if (message.type === "return_lobby") {

            if (client.id === room.host) {
                room.started = false;
            }

            return sendRoomUpdate(room);
        }

        /* =========================
           PLAYER STATE
        ========================= */

        if (message.type === "state" && message.player) {

            const p = message.player;

            client.player = {
                ...client.player,

                x: Number.isFinite(+p.x)
                    ? +p.x
                    : client.player.x,

                y: Number.isFinite(+p.y)
                    ? +p.y
                    : client.player.y,

                dir: +p.dir < 0 ? -1 : 1,

                hp: Math.max(
                    0,
                    Math.min(
                        100,
                        Number.isFinite(+p.hp)
                            ? +p.hp
                            : client.player.hp
                    )
                ),

                gun: String(
                    p.gun || client.player.gun
                ).slice(0, 30),

                stage: Math.max(
                    1,
                    Math.min(
                        5,
                        Number.isFinite(+p.stage)
                            ? +p.stage
                            : room.stage
                    )
                ),

                alive: p.alive !== false
            };

            return broadcastRoom(
                room,
                {
                    type: "state",
                    id: client.id,
                    player: client.player
                },
                client.id
            );
        }

        /* =========================
           SHOT
        ========================= */

        if (message.type === "shot" && message.shot) {

            const s = message.shot;

            return broadcastRoom(
                room,
                {
                    type: "shot",
                    id: client.id,
                    shot: {
                        x: Number(s.x) || 0,
                        y: Number(s.y) || 0,
                        vx: Number(s.vx) || 0,
                        vy: Number(s.vy) || 0,
                        d: Number(s.d) || 0
                    }
                },
                client.id
            );
        }

        /* =========================
           KILL
        ========================= */

        if (message.type === "kill") {

            return broadcastRoom(
                room,
                {
                    type: "kill",
                    id: client.id,
                    index: Number(message.index) || 0,
                    stage: Number(message.stage) || room.stage
                },
                client.id
            );
        }

        /* =========================
           STAGE
        ========================= */

        if (
            message.type === "stage" &&
            client.id === room.host
        ) {

            const stage = Math.max(
                1,
                Math.min(
                    5,
                    Number(message.stage) || 1
                )
            );

            room.stage = stage;

            for (const playerId of room.players) {

                const pc = clients.get(playerId);

                if (pc && pc.player) {
                    pc.player.stage = stage;
                }
            }

            return broadcastRoomIncludingSender(room, {
                type: "stage",
                stage
            });
        }
    });

    ws.on("close", () => {
        leaveRoom(client);
        clients.delete(id);
    });

    ws.on("error", () => {
        leaveRoom(client);
        clients.delete(id);
    });
});

server.on("error", error => {
    console.error("HTTP server error:", error);
});

wss.on("error", error => {
    console.error("WebSocket server error:", error);
});

server.listen(PORT, HOST, () => {
    console.log(
        `WWII Pixel Assault server running on ${HOST}:${PORT}`
    );
});
