// server.js
import express from "express";
import dotenv from "dotenv";
import { sendWhatsAppMessage } from "./controllers/whatsappController.js";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v2 as cloudinary } from "cloudinary";
import admin from "firebase-admin";

// 🔹 Load environment variables
dotenv.config();
const app = express();

// 🔹 File path helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔹 Ensure uploads folder exists (optional)
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// 🔹 Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🔹 Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 🔹 App middleware
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// In-memory store (optional)
let receivedMessagesStore = [];

// 🔹 Health
app.get("/", (req, res) => res.send("✅ WhatsApp API + Firebase connected successfully!"));

// 🔹 Send WhatsApp message route (your controller is kept)
app.post("/api/send-whatsapp", sendWhatsAppMessage);

// ================================================================
// ✅ STEP 1: VERIFY WEBHOOK
// ================================================================
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN; // <-- from ENV
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ WEBHOOK_VERIFIED");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ================================================================
// ✅ STEP 2: RECEIVE MESSAGES + DELIVERY STATUSES
// ================================================================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value) {
      return res.status(404).json({ error: "Invalid payload" });
    }

    // 1) Handle inbound messages (texts/images)
    const messages = value.messages;
    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        const from = msg.from; // e.g., "919209444201"
        const phoneNumber = from?.slice(-10) || "";
        const timestamp = new Date().toISOString();

        // Text message
        if (msg.text?.body) {
          const text = msg.text.body;
          console.log(`📩 Text from ${from}: ${text}`);
          receivedMessagesStore.push({ from, text, timestamp });
        }

        // Image message
        if (msg.image?.id) {
          const mediaId = msg.image.id;
          console.log(`🖼 Received image from ${phoneNumber} (Media ID: ${mediaId})`);

          try {
            // 1️⃣ Get media URL
            const metaHeaders = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
            const mediaRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: metaHeaders });
            const mediaUrl = mediaRes.data.url;

            // 2️⃣ Download buffer
            const imageResponse = await axios.get(mediaUrl, {
              responseType: "arraybuffer",
              headers: metaHeaders,
            });

            // 3️⃣ Upload to Cloudinary
            const uploadedImage = await new Promise((resolve, reject) => {
              const uploadStream = cloudinary.uploader.upload_stream(
                { folder: `whatsapp_media/${phoneNumber}` },
                (error, result) => (error ? reject(error) : resolve(result))
              );
              uploadStream.end(imageResponse.data);
            });

            console.log(`✅ Uploaded to Cloudinary: ${uploadedImage.secure_url}`);

            // 4️⃣ Save to Firestore
            const querySnapshot = await db
              .collection("teamRegistrations")
              .where("phoneNumber", "==", phoneNumber)
              .get();

            if (!querySnapshot.empty) {
              const docRef = querySnapshot.docs[0].ref;
              await docRef.update({
                images: admin.firestore.FieldValue.arrayUnion(uploadedImage.secure_url),
                verificationStatus: "image_uploaded",
              });
              console.log(`🔥 Saved Cloudinary URL for ${phoneNumber}`);
            } else {
              console.log(`⚠️ No matching record for ${phoneNumber} in Firestore.`);
            }

            receivedMessagesStore.push({
              from,
              text: `[Image] ${uploadedImage.secure_url}`,
              timestamp,
              mediaId,
              cloudinary_id: uploadedImage.public_id,
            });
          } catch (err) {
            console.error("❌ Error handling image:", err?.response?.data || err.message);
          }
        }
      }
    }

    // 2) Handle delivery statuses (THIS IS CRITICAL)
    const statuses = value.statuses;
    if (statuses && Array.isArray(statuses)) {
      for (const s of statuses) {
        const logObj = {
          id: s.id,
          status: s.status, // sent | delivered | read | failed
          timestamp: s.timestamp,
          recipient_id: s.recipient_id,
          conversation_origin: s.conversation?.origin?.type,
        };

        if (s.errors && s.errors.length) {
          const { code, title, details } = s.errors[0];
          logObj.error = { code, title, details };
          console.error("❌ delivery error:", JSON.stringify(logObj, null, 2));

          // Optional: persist in Firestore for analytics
          try {
            await db.collection("waDeliveryErrors").add({
              ...logObj,
              ts: admin.firestore.FieldValue.serverTimestamp(),
            });
          } catch (e) {
            console.error("⚠️ Failed to persist delivery error:", e.message);
          }
        } else {
          console.log("📦 delivery status:", JSON.stringify(logObj, null, 2));
        }
      }
    }

    // Respond OK so Meta doesn't retry
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// ================================================================
// ✅ STEP 3: GET ALL RECEIVED MESSAGES
// ================================================================
app.get("/api/messages", (req, res) => {
  res.status(200).json({ messages: receivedMessagesStore });
});

// ================================================================
// ✅ TEMPLATE SENDER (VERIFICATION MESSAGE ROUTES)
// ================================================================
const API_VERSION = "v20.0";
const GRAPH_BASE = process.env.WHATSAPP_API_URL || `https://graph.facebook.com/${API_VERSION}`;
const WHATSAPP_PHONE_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || "en"; // exact locale

const toDigits = (v) => String(v).replace(/[^\d]/g, "");

async function sendTemplateMessage(toRaw, templateName, langCode = TEMPLATE_LANG, components) {
  const to = toDigits(toRaw); // ensure E.164 digits
  const url = `${GRAPH_BASE}/${WHATSAPP_PHONE_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName, // must exactly match approved template name
      language: { code: langCode },
      ...(components ? { components } : {}),
    },
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });
    console.log(`✅ Template accepted: ${templateName} → ${to}`, response.data);
    return response.data;
  } catch (error) {
    console.error("❌ WhatsApp template send error:", error.response?.data || error.message);
    throw new Error(JSON.stringify(error.response?.data || { message: error.message }));
  }
}

async function handleVerify(req, res, templateName) {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: "Phone number is required" });

    console.log(`📨 Sending WhatsApp template "${templateName}" to: ${phoneNumber}`);
    const result = await sendTemplateMessage(phoneNumber, templateName);

    return res.status(200).json({
      success: true,
      template: templateName,
      message: `Message accepted: ${templateName}`,
      result,
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to send WhatsApp message",
      details: error.message,
    });
  }
}

// ✅ Routes — replace names if your approved templates differ
app.post("/api/verify/verified", (req, res) => handleVerify(req, res, "verified"));
app.post("/api/verify/not-verified", (req, res) => handleVerify(req, res, "not_verfied")); // <- fixed typo
app.post("/api/verify/pending", (req, res) => handleVerify(req, res, "pending"));

// ================================================================
// ✅ START SERVER
// ================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port http://localhost:${PORT}`)
);
