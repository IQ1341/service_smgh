require('dotenv').config(); // Load .env variables

const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const twilio = require('twilio');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

// Twilio Credentials from .env
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;

// DeepSeek API config
const DEEPSEEK_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

app.post('/webhook', async (req, res) => {
  try {
    const incomingMsgRaw = req.body.Body?.trim();
    const incomingMsg = incomingMsgRaw?.toLowerCase();
    const from = req.body.From;

    if (!incomingMsg || !from) {
      console.error('Invalid message data:', req.body);
      return res.status(400).send('Bad Request: Missing message body or sender info.');
    }

    console.log('📩 Message from:', from, '->', incomingMsg);

    const statusRef = db.ref('status/devices');
    const schedulesRef = db.ref('schedules');
    let responseMsg = '';

    const greetings = ['hi', 'halo', 'hallo', 'assalamualaikum', 'selamat pagi', 'selamat siang', 'selamat sore', 'selamat malam'];
    if (greetings.includes(incomingMsg)) {
      responseMsg = `👋 Halo! Saya asisten Smart Greenhouse.\nKetik *menu* untuk melihat perintah yang tersedia.`;
    } else if (incomingMsg.startsWith('jadwal')) {
      const parts = incomingMsgRaw.split(/\s+/);
      const type = parts[1];
      const times = parts.slice(2).filter(t => /^\d{2}:\d{2}$/.test(t));
      const durIndex = parts.findIndex(p => p === 'durasi');
      const duration = durIndex !== -1 ? parseInt(parts[durIndex + 1]) : 5;

      if ((type === 'air' || type === 'pupuk') && times.length > 0 && !isNaN(duration)) {
        const scheduleType = type === 'air' ? 'watering' : 'fertilizing';
        await schedulesRef.child(scheduleType).set({ enabled: true, times, duration });
        responseMsg = `✅ Jadwal ${type === 'air' ? 'penyiraman' : 'pemupukan'} disimpan:\nWaktu: ${times.join(', ')}\nDurasi: ${duration} menit`;
      } else {
        responseMsg = '❌ Format salah. Contoh: *jadwal air 06:00 18:00 durasi 5*';
      }
    } else {
      switch (incomingMsg) {
        case 'menu':
        case 'help':
        case 'start':
          responseMsg = `📋 *Menu Perintah Smart Greenhouse:*\n\n1️⃣ *water on/off* – Nyalakan/matikan pompa air 💧\n2️⃣ *fertilizer on/off* – Nyalakan/matikan pompa pupuk 🌿\n3️⃣ *cooler on/off* – Nyalakan/matikan pendingin ❄️\n4️⃣ *sensor* – Cek data suhu, kelembapan udara, & tanah 🌡️\n5️⃣ *jadwal air/pupuk [waktu...] durasi [menit]* – Jadwal otomatis\n\n💡 Contoh: ketik *water on* untuk menyalakan pompa air.`;
          break;
        case 'water on':
          await statusRef.child('water').set(true);
          responseMsg = '💧 Pompa air dinyalakan!';
          break;
        case 'water off':
          await statusRef.child('water').set(false);
          responseMsg = '⚫ Pompa air dimatikan!';
          break;
        case 'fertilizer on':
          await statusRef.child('fertilizer').set(true);
          responseMsg = '🌿 Pompa pupuk dinyalakan!';
          break;
        case 'fertilizer off':
          await statusRef.child('fertilizer').set(false);
          responseMsg = '⚫ Pompa pupuk dimatikan!';
          break;
        case 'cooler on':
          await statusRef.child('cooler').set(true);
          responseMsg = '❄️ Pendingin dinyalakan!';
          break;
        case 'cooler off':
          await statusRef.child('cooler').set(false);
          responseMsg = '⚫ Pendingin dimatikan!';
          break;
        case 'sensor':
          const sensorSnapshot = await db.ref('sensor/data').once('value');
          const sensor = sensorSnapshot.val();
          if (sensor) {
            responseMsg = `🌡️ Suhu: ${sensor.temperature?.toFixed(1)} °C\n💧 Kelembapan Udara: ${sensor.humidity?.toFixed(1)} %\n🌱 Kelembapan Tanah: ${sensor.soilMoisture?.toFixed(1)} %`;
          } else {
            responseMsg = '⚠️ Data sensor belum tersedia.';
          }
          break;
        default:
          try {
            const deepseekResponse = await axios.post(
              DEEPSEEK_API_URL,
              {
                model: "openai/gpt-4o",
                messages: [{ role: "user", content: incomingMsgRaw }]
              },
              {
                headers: {
                  'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
                  'Content-Type': 'application/json'
                }
              }
            );
            responseMsg = deepseekResponse.data.choices[0].message.content.trim();
          } catch (error) {
            console.error('Error from DeepSeek API:', error.response?.data || error.message);
            responseMsg = 'Maaf, saya tidak bisa menjawab sekarang. Silakan coba lagi nanti.';
          }
          break;
      }
    }

    await client.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: from,
      body: responseMsg,
    });

    res.status(200).send('Message sent');
  } catch (err) {
    console.error('❌ Error saat memproses webhook:', err);
    res.status(500).send('Internal Server Error');
  }
});

cron.schedule('* * * * *', async () => {
  const now = new Date();
  const currentTime = now.toTimeString().substring(0, 5);
  const schedules = (await db.ref('schedules').once('value')).val();

  if (schedules?.watering?.enabled && schedules.watering.times.includes(currentTime)) {
    await db.ref('status/devices/water').set(true);
    setTimeout(() => db.ref('status/devices/water').set(false), (schedules.watering.duration || 5) * 60000);
  }

  if (schedules?.fertilizing?.enabled && schedules.fertilizing.times.includes(currentTime)) {
    await db.ref('status/devices/fertilizer').set(true);
    setTimeout(() => db.ref('status/devices/fertilizer').set(false), (schedules.fertilizing.duration || 5) * 60000);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
