// Serverless entry for Netlify Functions
import { createLambdaFunction, createProbot } from "@probot/adapter-aws-lambda-serverless";
import app from "../../app.js"; // <-- your Probot app from earlier

export const handler = createLambdaFunction(app, {
  probot: createProbot({
    appId: process.env.APP_ID,
    privateKey: process.env.PRIVATE_KEY,
    secret: process.env.WEBHOOK_SECRET,
  }),
});
