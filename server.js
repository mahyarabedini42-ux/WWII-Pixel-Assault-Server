const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const MAX_PLAYERS_PER_ROOM = 4;

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

function sendResponse(
  res,
  status,
  body,
  type = "text/plain; charset=utf-8"
) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });

  res.end(body);
}

const server = http.createServer((req, res) => {
  let urlPath;

  try {
    urlPath = decodeURIComponent(
      (req.url || "/").split("?")[0]
    );
  } catch {
    return sendResponse(res, 400, "Bad Request");
  }

  if (urlPath === "/") {
    urlPath = "/index.html";
  }

  if (urlPath.includes("..")) {
    return sendResponse(res, 400, "Bad Request");
  }

  const filePath = path.join(__dirname, urlPath);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return sendResponse(res, 404, "Not found");
    }

    const extension = path.extname(filePath).toLowerCase();

    const contentType =
      MIME[extension] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });

    const stream = fs.createReadStream(filePath);

    stream.on("error", () => {
      if (!res.headersSent) {
        sendResponse(res, 500, "Internal Server Error");
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
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

function roomPlayers(room) {
  const players = {};

  for (const id of room.players) {
    const client = clients.get(id);

    if (client && client.name && client.player) {
      players[id] = {
        ...client.player,
        host: id === room.host
      };
    }
  }

  return players;
}

function broadcastRoom(room, message, exceptId = null) {
  const encoded = JSON.stringify(message);

  for (const id of room.players) {
    if (id === exceptId) continue;

    const client = clients.get(id);

    if (
      client &&
      client.ws.readyState === WebSocket.OPEN
    ) {
      client.ws.send(encoded);
    }
  }
}

function updateRoom(room) {
  broadcastRoom(room, {
    type: "room",
    code: room.code,
    host: room.host,
    players: roomPlayers(room)
  });
}

function nameTaken(room, name, exceptId = null) {
  const wanted = name.toLowerCase();

  for (const id of room.players) {
    if (id === exceptId) continue;

    const client = clients.get(id);

    if (
      client &&
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
    room.host =
      room.players.values().next().value || null;
  }

  if (room.players.size === 0) {
    rooms.delete(room.code);
  } else {
    updateRoom(room);
  }
}

wss.on("connection", (ws) => {
  if (clients.size >= 100) {
    ws.close(1013, "Server is full");
    return;
  }

  const id = String(nextId++);

  const client = {
    ws,
    id,
    name: "",
    player: null,
    room: null
  };

  clients.set(id, client);

  safeSend(client, {
    type: "connected",
    id
  });

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (
      !message ||
      typeof message.type !== "string"
    ) {
      return;
    }

    // ورود بازیکن
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
        name,
        id,
        x: 120,
        y: 500,
        dir: 1,
        hp: 100,
        gun: "pistol",
        stage: 1
      };

      return safeSend(client, {
        type: "welcome",
        id
      });
    }

    if (!client.name) return;

    // ساخت اتاق
    if (message.type === "create_room") {
      leaveRoom(client);

      const code = makeRoomCode();

      const room = {
        code,
        host: client.id,
        players: new Set([client.id])
      };

      rooms.set(code, room);

      client.room = code;

      return safeSend(client, {
        type: "room_created",
        code,
        host: true,
        players: roomPlayers(room)
      });
    }

    // ورود به اتاق
    if (message.type === "join_room") {
      const code = String(
        message.code || ""
      ).replace(/\D/g, "");

      if (!/^\d{6}$/.test(code)) {
        return safeSend(client, {
          type: "error",
          message: "رمز اتاق باید ۶ رقمی باشد."
        });
      }

      const room = rooms.get(code);

      if (!room) {
        return safeSend(client, {
          type: "error",
          message: "این اتاق پیدا نشد."
        });
      }

      if (
        room.players.size >=
        MAX_PLAYERS_PER_ROOM
      ) {
        return safeSend(client, {
          type: "error",
          message:
            "این اتاق پر است؛ حداکثر ۴ نفر."
        });
      }

      if (
        nameTaken(
          room,
          client.name,
          client.id
        )
      ) {
        return safeSend(client, {
          type: "error",
          message:
            "این نام در این اتاق قبلاً استفاده شده است."
        });
      }

      leaveRoom(client);

      room.players.add(client.id);
      client.room = code;

      safeSend(client, {
        type: "room_joined",
        code,
        host: client.id === room.host,
        players: roomPlayers(room)
      });

      updateRoom(room);

      return;
    }

    // خروج از اتاق
    if (message.type === "leave_room") {
      leaveRoom(client);

      return safeSend(client, {
        type: "players",
        players: {}
      });
    }

    if (!client.room) return;

    const room = rooms.get(client.room);

    if (!room) return;

    // وضعیت بازیکن
    if (
      message.type === "state" &&
      message.player
    ) {
      const p = message.player;

      client.player = {
        ...client.player,

        x: Number.isFinite(+p.x)
          ? +p.x
          : 0,

        y: Number.isFinite(+p.y)
          ? +p.y
          : 0,

        dir: +p.dir < 0 ? -1 : 1,

        hp: Math.max(
          0,
          Math.min(
            100,
            Number.isFinite(+p.hp)
              ? +p.hp
              : 0
          )
        ),

        gun: String(
          p.gun || "pistol"
        ).slice(0, 30),

        stage: Math.max(
          1,
          Math.min(
            5,
            Number.isFinite(+p.stage)
              ? +p.stage
              : 1
          )
        )
      };

      return broadcastRoom(
        room,
        {
          type: "state",
          id,
          player: client.player
        },
        id
      );
    }

    // شلیک
    if (
      message.type === "shot" &&
      message.shot
    ) {
      const s = message.shot;

      return broadcastRoom(
        room,
        {
          type: "shot",
          id,

          shot: {
            x: +s.x || 0,
            y: +s.y || 0,
            vx: +s.vx || 0,
            vy: +s.vy || 0,
            d: +s.d || 0
          }
        },
        id
      );
    }

    // کشتن دشمن
    if (message.type === "kill") {
      return broadcastRoom(
        room,
        {
          type: "kill",
          id,
          index: +message.index || 0,
          stage: +message.stage || 1
        },
        id
      );
    }

    // تغییر مرحله توسط میزبان
    if (
      message.type === "stage" &&
      client.id === room.host
    ) {
      const stage = Math.max(
        1,
        Math.min(
          5,
          Number.isFinite(+message.stage)
            ? +message.stage
            : 1
        )
      );

      for (const playerId of room.players) {
        const playerClient =
          clients.get(playerId);

        if (
          playerClient &&
          playerClient.player
        ) {
          playerClient.player.stage = stage;
        }
      }

      return broadcastRoom(room, {
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

server.on("error", (error) => {
  console.error(
    "HTTP server error:",
    error
  );
});

wss.on("error", (error) => {
  console.error(
    "WebSocket server error:",
    error
  );
});

server.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `WWII Pixel Assault online room server: ${PORT}`
    );

    console.log(
      `Listening on ${HOST}:${PORT}`
    );
  }
);
