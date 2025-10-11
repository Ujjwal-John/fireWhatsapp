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

// Parse the env variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// Replace escaped line breaks with real line breaks
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore(); // Firestore reference

// 🔹 Enable CORS
app.use(cors({
  origin: [
    "http://127.0.0.1:5500",
    "http://localhost:5501",
    "https://colabesports.in",
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

// In-memory store (optional)
let receivedMessagesStore = [];

// 🔹 Send WhatsApp message route
app.post("/api/send-whatsapp", sendWhatsAppMessage);

// Root route
app.get("/", (req, res) => res.send("✅ WhatsApp API + Firebase connected successfully!"));

// ================================================================
// ✅ STEP 1: VERIFY WEBHOOK
// ================================================================
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "my_verify_token";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
});

// ================================================================
// ✅ STEP 2: RECEIVE MESSAGES
// ================================================================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (!(body.object && body.entry)) {
      return res.status(404).json({ error: "Invalid payload" });
    }

    const messages = body.entry[0].changes[0]?.value.messages;
    if (!messages) return res.status(200).json({ status: "no messages" });

    for (const msg of messages) {
      const from = msg.from; // WhatsApp phone number (e.g., '919209444201')
      const phoneNumber = from.slice(-10); // extract 10 digits (e.g., '9209444201')
      const timestamp = new Date().toISOString();

      // ✅ TEXT MESSAGE
      if (msg.text?.body) {
        const text = msg.text.body;
        console.log(`📩 Text from ${from}: ${text}`);
        receivedMessagesStore.push({ from, text, timestamp });
      }

      // ✅ IMAGE MESSAGE
      if (msg.image?.id) {
        const mediaId = msg.image.id;
        console.log(`🖼 Received image from ${phoneNumber} (Media ID: ${mediaId})`);

        try {
          // 1️⃣ Get media URL from WhatsApp API
          const mediaRes = await axios.get(
            `https://graph.facebook.com/v20.0/${mediaId}`,
            {
              headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
            }
          );
          const mediaUrl = mediaRes.data.url;

          // 2️⃣ Download the image as buffer
          const imageResponse = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
          });

          // 3️⃣ Upload to Cloudinary (folder: whatsapp_media/{phoneNumber})
          const uploadedImage = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
              {
                folder: `whatsapp_media/${phoneNumber}`,
              },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            );
            uploadStream.end(imageResponse.data);
          });

          console.log(`✅ Uploaded to Cloudinary: ${uploadedImage.secure_url}`);

          // 4️⃣ Save Cloudinary URL to Firestore (match by phone number)
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

            console.log(`🔥 Image URL saved in Firebase for ${phoneNumber}`);
          } else {
            console.log(`⚠️ No matching record found for ${phoneNumber} in Firestore.`);
          }

          receivedMessagesStore.push({
            from,
            text: `[Image] ${uploadedImage.secure_url}`,
            timestamp,
            mediaId,
            cloudinary_id: uploadedImage.public_id,
          });

        } catch (err) {
          console.error("❌ Error handling image:", err.message);
        }
      }
    }

    res.status(200).json({ status: "received" });
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ================================================================
// ✅ STEP 3: GET ALL RECEIVED MESSAGES
// ================================================================
app.get("/api/messages", (req, res) => {
  res.status(200).json({ messages: receivedMessagesStore });
});

// ================================================================
// ✅ START SERVER
// ================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Server running on port http://localhost:${PORT}`)
);
