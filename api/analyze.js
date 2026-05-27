import { Resend } from 'resend';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, image } = req.body;

  try {
    const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // ETAPE 1 : Obtenir une URL d'upload signée
    const fileResponse = await fetch('https://yce-api-01.makeupar.com/s2s/v2.0/file/skin-analysis', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERFECT_CORP_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        files: [{
          content_type: 'image/jpeg',
          file_name: 'skin_analysis.jpg',
          file_size: imageBuffer.length
        }]
      })
    });

    const fileData = await fileResponse.json();
    console.log('File response:', JSON.stringify(fileData));

    if (!fileData.files || !fileData.files[0]) {
      throw new Error('File creation échouée: ' + JSON.stringify(fileData));
    }

    const { upload_url, file_id } = fileData.files[0];

    // ETAPE 2 : Uploader l'image sur l'URL signée
    const uploadResponse = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: imageBuffer
    });

    console.log('Upload status:', uploadResponse.status);

    // ETAPE 3 : Lancer l'analyse
    const analysisResponse = await fetch('https://yce-api-01.makeupar.com/s2s/v2.0/task/skin-analysis', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERFECT_CORP_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        src_file_id: file_id,
        dst_actions: ["acne", "pore", "spots", "wrinkle"]
      })
    });

    const analysisData = await analysisResponse.json();
    console.log('Analysis response:', JSON.stringify(analysisData));

    // ETAPE 4 : Canvas avec la photo d'origine
    const imgSource = await loadImage(image);
    const canvas = createCanvas(imgSource.width, imgSource.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgSource, 0, 0);

    const skinData = analysisData.results || {};

    // Rides (rouge)
    if (skinData.wrinkle && skinData.wrinkle.areas) {
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
      ctx.lineWidth = 2;
      skinData.wrinkle.areas.forEach(area => {
        if (area.points && area.points.length > 1) {
          ctx.beginPath();
          ctx.moveTo(area.points[0].x, area.points[0].y);
          for (let i = 1; i < area.points.length; i++) {
            ctx.lineTo(area.points[i].x, area.points[i].y);
          }
          ctx.stroke();
        }
      });
    }

    // Pores (vert)
    if (skinData.pore && skinData.pore.areas) {
      ctx.fillStyle = 'rgba(0, 255, 0, 0.35)';
      skinData.pore.areas.forEach(area => {
        ctx.fillRect(area.x, area.y, area.width, area.height);
      });
    }

    // Taches (jaune)
    if (skinData.spots && skinData.spots.areas) {
      ctx.fillStyle = 'rgba(255, 215, 0, 0.4)';
      skinData.spots.areas.forEach(area => {
        const radius = Math.max(area.width, area.height) / 2;
        const centerX = area.x + radius;
        const centerY = area.y + radius;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
        ctx.fill();
      });
    }

    // Acné (violet)
    if (skinData.acne && skinData.acne.areas) {
      ctx.strokeStyle = 'rgba(155, 89, 182, 0.9)';
      ctx.lineWidth = 2;
      skinData.acne.areas.forEach(area => {
        ctx.strokeRect(area.x, area.y, area.width, area.height);
      });
    }

    // Export base64
    const finalImageBase64 = canvas.toDataURL('image/jpeg', 0.85);

    // Scores
    const scores = {
      acne: skinData.acne?.ui_score ?? 100,
      pore: skinData.pore?.ui_score ?? 100,
      spots: skinData.spots?.ui_score ?? 100,
      wrinkle: skinData.wrinkle?.ui_score ?? 100
    };

    // Envoi email
    await resend.emails.send({
      from: 'Nuhanciam <diagnostic@nuhanciam.com>',
      to: email,
      subject: '✨ Votre cartographie cutanée personnalisée',
      html: `
        <div style="font-family: sans-serif; max-width: 550px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
          <h2>Résultats de votre analyse de peau</h2>
          <p>Voici la cartographie générée par notre IA basé sur vos 4 piliers de soin :</p>
          <div style="text-align: center; margin: 20px 0;">
            <img src="${finalImageBase64}" alt="Cartographie Visage" style="max-width: 100%; border-radius: 6px;" />
          </div>
          <h3 style="margin-top:20px;">Vos scores de santé (sur 100) :</h3>
          <ul style="list-style: none; padding: 0;">
            <li style="padding: 8px 0; border-bottom: 1px solid #f5f5f5;">🟣 <strong>Acné / Imperfections :</strong> ${scores.acne}/100</li>
            <li style="padding: 8px 0; border-bottom: 1px solid #f5f5f5;">🟢 <strong>Pores dilatés :</strong> ${scores.pore}/100</li>
            <li style="padding: 8px 0; border-bottom: 1px solid #f5f5f5;">🟡 <strong>Taches / Hyperpigmentation :</strong> ${scores.spots}/100</li>
            <li style="padding: 8px 0; border-bottom: 1px solid #f5f5f5;">🔴 <strong>Rides & Ridules :</strong> ${scores.wrinkle}/100</li>
          </ul>
          <p style="font-size: 12px; color: #777; margin-top: 20px;">
            *Note : Plus le score est proche de 100, plus la peau est saine sur ce critère.
          </p>
        </div>
      `
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("Erreur durant le traitement :", error);
    return res.status(500).json({ error: error.message });
  }
}