import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

/**
 * Send WhatsApp Message using Meta Cloud API
 */
export const sendWhatsAppMessage = async (req, res) => {
  try {
    const { name, phone } = req.body;

    // Validate input
    if (!phone)
      return res.status(400).json({ error: "Phone number is required" });

    // Format phone (remove spaces, ensure country code)
    const formattedPhone = phone.replace(/\s+/g, "");

    // ✅ Use "hello_world" without parameters (since it has no {{1}})
    const payload = {
      messaging_product: "whatsapp",
      to: formattedPhone,
      type: "template",
      template: {
        name: "hello_world", // Meta's built-in test template
        language: { code: "en_US" }
      }
    };

    const response = await axios.post(WHATSAPP_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    console.log("✅ WhatsApp message sent:", response.data);
    res.json({ success: true, data: response.data });
  } catch (error) {
    console.error("❌ Error sending WhatsApp message:", error.response?.data || error);
    res.status(500).json({ error: error.response?.data || error.message });
  }
};
