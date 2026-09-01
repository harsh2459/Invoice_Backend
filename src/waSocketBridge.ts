/**
 * Bridges waEvents onto Socket.IO. Every WhatsApp event carries a companyId; the
 * frontend joins one room per company (`company:<id>`), so an inbox open on
 * company A only receives A's traffic.
 *
 * Namespace: /whatsapp   handshake auth: { token: <JWT> }
 * Client -> server:  socket.emit("join", companyId) / socket.emit("leave", companyId)
 * Server -> client:  wa:status, wa:chat, wa:message, wa:message-update, wa:contact
 *                    (each payload includes companyId)
 */
import type { Server as HttpServer } from "http";
import { Server as IOServer } from "socket.io";
import jwt from "jsonwebtoken";
import { config } from "./config";
import { waEvents, allStates } from "./whatsapp";

const room = (companyId: number | string) => `company:${companyId}`;

export function attachWaSocket(httpServer: HttpServer): IOServer {
  const socketOrigins = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const io = new IOServer(httpServer, {
    path: "/socket.io",
    cors: { origin: socketOrigins.length ? socketOrigins : true, credentials: true },
  });

  const wa = io.of("/whatsapp");

  wa.use((socket, next) => {
    const hdrAuth = socket.handshake.headers?.authorization;
    const token =
      (socket.handshake.auth && (socket.handshake.auth as any).token) ||
      (socket.handshake.query && (socket.handshake.query as any).token) ||
      (hdrAuth && hdrAuth.startsWith("Bearer ") ? hdrAuth.slice(7) : undefined);
    if (!token) return next(new Error("Unauthorized"));
    try {
      const decoded = jwt.verify(String(token), config.jwtSecret) as { id: number; role: string };
      if (decoded.role !== "admin") return next(new Error("Forbidden"));
      (socket.data as any).user = decoded;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  wa.on("connection", (socket) => {
    socket.on("join", (companyId: number) => {
      if (!Number.isInteger(companyId)) return;
      socket.join(room(companyId));
      const st = allStates().find((s) => s.companyId === companyId);
      if (st) socket.emit("wa:status", st);
    });
    socket.on("leave", (companyId: number) => {
      if (Number.isInteger(companyId)) socket.leave(room(companyId));
    });
  });

  // Fan waEvents out to the matching company room.
  const forward = (event: string) => (payload: any) => {
    if (!payload || payload.companyId == null) return;
    wa.to(room(payload.companyId)).emit(event, payload);
  };
  waEvents.on("status", forward("wa:status"));
  waEvents.on("chat", forward("wa:chat"));
  waEvents.on("message", forward("wa:message"));
  waEvents.on("message-update", forward("wa:message-update"));
  waEvents.on("contact", forward("wa:contact"));

  return io;
}
