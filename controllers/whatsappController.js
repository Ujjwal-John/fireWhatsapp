import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const WHATSAPP_API_URL = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

export const sendWhatsAppMessage = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "User phone number is required" });
    }

    const formattedUserPhone = phone.replace(/\s+/g, "");

    const payload = {
  messaging_product: "whatsapp",
  to: formattedUserPhone,
  type: "template",
  template: {
    name: "colabgreeting", // Must match your approved template name
    language: { code: "en" }, // Use exact language (check in WhatsApp Manager)
    components: [
      {
        type: "header",
        parameters: [
          {
            type: "image",
            image: {
              link: "https://res.cloudinary.com/dpjflcgx5/image/upload/v1762418709/1.2_2_1_vpbxlx.jpg" // 👈 Public URL of your image
            }
          }
        ]
      }
    ]
  }
};

    const response = await axios.post(WHATSAPP_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ 'verified' template sent:", response.data);
    res.status(200).json({
      success: true,
      message: "Utility template 'verified' sent successfully.",
      data: response.data,
    });
  } catch (error) {
    console.error("❌ Error sending WhatsApp message:", error.response?.data || error);
    res.status(500).json({ error: error.response?.data || error.message });
  }
};