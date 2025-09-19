// server.js
import express from "express";
import { Probot } from "probot";
import appFn from "./app.js";

const app = express();
const probot = new Probot({
  appId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY,
  secret: process.env.WEBHOOK_SECRET,
});

probot.load(appFn);
app.use("/api/github/webhooks", probot.webhooks.middleware);
app.get("/health", (_req, res) => res.send("ok"));
app.listen(process.env.PORT || 3000, () => console.log("Day0 Guard running"));
