import { Resend } from 'resend';
import { createCanvas, loadImage } from '@napi-rs/canvas';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb'
    }
  }
};

const resend = new Resend(process.env.RESEND_API_KEY);

const PERFECT_API_VERSION = process.env.PERFECT_API_VERSION || 'v2.1';
const PERFECT_API_BASE = `https://yce-api-01.makeupar.com/s2s/${PERFECT_API_VERSION}`;

const ANALYSIS_ACTIONS = [
  {
    type: 'acne',
    scoreKey: 'acne',
    label: 'Acne / Imperfections',
    color: '#9b59b6',
    opacity: 0.55
  },
  {
    type: 'pore',
    scoreKey: 'pore',
    label: 'Pores dilates',
    color: '#2ecc71',
    opacity: 0.42
  },
  {
    type: 'age_spot',
    scoreKey: 'spots',
    label: 'Taches / Hyperpigmentation',
    color: '#f1c40f',
    opacity: 0.5
  },
  {
    type: 'wrinkle',
    scoreKey: 'wrinkle',
    label: 'Rides & Ridules',
    color: '#e74c3c',
    opacity: 0.55
  }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readJson(response, label) {
  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${label}: reponse non JSON (${response.status}) ${text.slice(0, 500)}`);
  }

  if (!response.ok || Number(data.status) >= 400 || data.error) {
    throw new Error(`${label}: ${JSON.stringify(data)}`);
  }

  return data;
}

async function fetchBuffer(url, label) {
  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label}: telechargement echoue (${response.status}) ${text.slice(0, 500)}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function cleanInputImage(image) {
  if (!image || typeof image !== 'string') {
    throw new Error('Image manquante ou invalide');
  }

  let contentType = 'image/jpeg';
  let base64Data = image;

  const dataUrlMatch = image.match(/^data:(image\/(?:jpeg|jpg|png));base64,(.+)$/i);

  if (dataUrlMatch) {
    contentType = dataUrlMatch[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    base64Data = dataUrlMatch[2];
  } else if (image.includes(',')) {
    base64Data = image.split(',')[1];
  }

  base64Data = base64Data.replace(/\s/g, '');

  const imageBuffer = Buffer.from(base64Data, 'base64');

  if (!imageBuffer.length) {
    throw new Error('Image base64 vide apres decodage');
  }

  const extension = contentType.includes('png') ? 'png' : 'jpg';

  return {
    contentType,
    extension,
    base64Data,
    imageBuffer,
    dataUrl: `data:${contentType};base64,${base64Data}`
  };
}

async function createPerfectCorpFile({ contentType, extension, imageBuffer }) {
  const response = await fetch(`${PERFECT_API_BASE}/file/skin-analysis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERFECT_CORP_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      files: [
        {
          content_type: contentType,
          file_name: `skin_analysis.${extension}`,
          file_size: imageBuffer.length
        }
      ]
    })
  });

  const data = await readJson(response, 'Creation fichier Perfect Corp');
  const fileInfo = data.data?.files?.[0];

  if (!fileInfo?.file_id || !fileInfo?.requests?.[0]?.url) {
    throw new Error('Reponse File API invalide: ' + JSON.stringify(data));
  }

  return fileInfo;
}

async function uploadImageToPerfectCorp(fileInfo, imageBuffer, contentType) {
  const uploadRequest = fileInfo.requests[0];

  const headers = {};
  for (const [key, value] of Object.entries(uploadRequest.headers || {})) {
    headers[key] = String(value);
  }

  if (!headers['Content-Type']) {
    headers['Content-Type'] = contentType;
  }

  if (!headers['Content-Length']) {
    headers['Content-Length'] = String(imageBuffer.length);
  }

  const response = await fetch(uploadRequest.url, {
    method: uploadRequest.method || 'PUT',
    headers,
    body: imageBuffer
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload Perfect Corp echoue (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function startSkinAnalysis(fileId) {
  const response = await fetch(`${PERFECT_API_BASE}/task/skin-analysis`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERFECT_CORP_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      src_file_id: fileId,
      dst_actions: ANALYSIS_ACTIONS.map((action) => action.type),
      format: 'json',
      pf_camera_kit: true,
      miniserver_args: {
        enable_mask_overlay: false
      }
    })
  });

  const data = await readJson(response, 'Creation analyse Perfect Corp');
  const taskId = data.data?.task_id;

  if (!taskId) {
    throw new Error('Aucun task_id Perfect Corp: ' + JSON.stringify(data));
  }

  return taskId;
}

async function pollSkinAnalysis(taskId) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await sleep(attempt === 0 ? 1500 : 2000);

    const response = await fetch(`${PERFECT_API_BASE}/task/skin-analysis/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${process.env.PERFECT_CORP_SECRET_KEY}`
      }
    });

    const data = await readJson(response, 'Polling Perfect Corp');
    const status = String(data.data?.task_status || '').toLowerCase();

    if (status === 'success') {
      return data;
    }

    if (status === 'error' || status === 'failed' || status === 'failure') {
      throw new Error('Analyse Perfect Corp en erreur: ' + JSON.stringify(data));
    }
  }

  throw new Error('Timeout analyse Perfect Corp');
}

function getAnalysisOutputs(taskData) {
  const outputs = taskData.data?.results?.output;

  if (!Array.isArray(outputs)) {
    throw new Error(
      'Aucun output JSON exploitable. Verifie que format=json est accepte: ' +
        JSON.stringify(taskData)
    );
  }

  return outputs;
}

function findOutput(outputs, type) {
  return outputs.find((output) => output.type === type);
}

function getScore(outputs, type) {
  const output = findOutput(outputs, type);
  const score = output?.ui_score;

  return Number.isFinite(score) ? Math.round(score) : null;
}

function parseHexColor(hex) {
  const clean = hex.replace('#', '');

  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function drawTintedMask(ctx, maskImage, color, opacity) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  const maskCanvas = createCanvas(width, height);
  const maskCtx = maskCanvas.getContext('2d');

  maskCtx.drawImage(maskImage, 0, 0, width, height);

  const imageData = maskCtx.getImageData(0, 0, width, height);
  const pixels = imageData.data;
  const rgb = parseHexColor(color);

  let checked = 0;
  let transparent = 0;

  for (let i = 3; i < pixels.length; i += 400) {
    checked += 1;
    if (pixels[i] < 250) transparent += 1;
  }

  const hasRealAlpha = checked > 0 && transparent / checked > 0.01;

  for (let i = 0; i < pixels.length; i += 4) {
    const sourceAlpha = pixels[i + 3];
    const luminance = Math.round(
      pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722
    );

    const alphaBase = hasRealAlpha ? sourceAlpha : luminance;
    const alpha = alphaBase < 12 ? 0 : Math.round(Math.min(255, alphaBase * opacity));

    pixels[i] = rgb.r;
    pixels[i + 1] = rgb.g;
    pixels[i + 2] = rgb.b;
    pixels[i + 3] = alpha;
  }

  maskCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(maskCanvas, 0, 0);
}

async function drawDetectedMasks(ctx, outputs) {
  const drawn = [];

  for (const action of ANALYSIS_ACTIONS) {
    const output = findOutput(outputs, action.type);
    const maskUrls = Array.isArray(output?.mask_urls) ? output.mask_urls : [];

    for (const maskUrl of maskUrls) {
      try {
        const maskBuffer = await fetchBuffer(maskUrl, `Mask ${action.type}`);
        const maskImage = await loadImage(maskBuffer);

        drawTintedMask(ctx, maskImage, action.color, action.opacity);
        drawn.push(action.type);
      } catch (error) {
        console.error(`Impossible de dessiner le masque ${action.type}:`, error);
      }
    }
  }

  return drawn;
}

function formatScore(score) {
  return score === null || score === undefined ? 'N/A' : `${score}/100`;
}

function buildEmailHtml(scores) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 22px; border: 1px solid #eee; border-radius: 8px;">
      <h2 style="margin: 0 0 12px;">Resultats de votre analyse de peau</h2>
      <p style="line-height: 1.5; color: #444;">
        Voici votre cartographie cutanee personnalisee avec les zones detectees par l'analyse.
      </p>

      <div style="text-align: center; margin: 22px 0;">
        <img src="cid:skin-map" alt="Cartographie visage" style="max-width: 100%; border-radius: 8px; display: block;" />
      </div>

      <h3 style="margin: 24px 0 10px;">Vos scores</h3>

      <ul style="list-style: none; padding: 0; margin: 0;">
        <li style="padding: 9px 0; border-bottom: 1px solid #f0f0f0;">
          <span style="display:inline-block;width:10px;height:10px;background:#9b59b6;border-radius:50%;margin-right:8px;"></span>
          <strong>Acne / Imperfections :</strong> ${formatScore(scores.acne)}
        </li>
        <li style="padding: 9px 0; border-bottom: 1px solid #f0f0f0;">
          <span style="display:inline-block;width:10px;height:10px;background:#2ecc71;border-radius:50%;margin-right:8px;"></span>
          <strong>Pores dilates :</strong> ${formatScore(scores.pore)}
        </li>
        <li style="padding: 9px 0; border-bottom: 1px solid #f0f0f0;">
          <span style="display:inline-block;width:10px;height:10px;background:#f1c40f;border-radius:50%;margin-right:8px;"></span>
          <strong>Taches / Hyperpigmentation :</strong> ${formatScore(scores.spots)}
        </li>
        <li style="padding: 9px 0;">
          <span style="display:inline-block;width:10px;height:10px;background:#e74c3c;border-radius:50%;margin-right:8px;"></span>
          <strong>Rides & Ridules :</strong> ${formatScore(scores.wrinkle)}
        </li>
      </ul>
    </div>
  `;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY manquante');
    }

    if (!process.env.PERFECT_CORP_SECRET_KEY) {
      throw new Error('PERFECT_CORP_SECRET_KEY manquante');
    }

    const { email, image } = req.body || {};

    if (!email || !String(email).includes('@')) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    const cleanImage = cleanInputImage(image);

    const fileInfo = await createPerfectCorpFile(cleanImage);
    await uploadImageToPerfectCorp(fileInfo, cleanImage.imageBuffer, cleanImage.contentType);

    const taskId = await startSkinAnalysis(fileInfo.file_id);
    const taskData = await pollSkinAnalysis(taskId);
    const outputs = getAnalysisOutputs(taskData);

    const originalImage = await loadImage(cleanImage.dataUrl);
    const canvas = createCanvas(originalImage.width, originalImage.height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(originalImage, 0, 0);

    const drawnMasks = await drawDetectedMasks(ctx, outputs);

    const finalImageBase64 = canvas.toDataURL('image/jpeg', 0.88);
    const finalImageAttachment = finalImageBase64.split(',')[1];

    const scores = {
      acne: getScore(outputs, 'acne'),
      pore: getScore(outputs, 'pore'),
      spots: getScore(outputs, 'age_spot'),
      wrinkle: getScore(outputs, 'wrinkle')
    };

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: process.env.RESEND_FROM || 'Diagnostic Peau <onboarding@resend.dev>',
      to: email,
      subject: 'Votre cartographie cutanee personnalisee',
      html: buildEmailHtml(scores),
      attachments: [
        {
          filename: 'cartographie-visage.jpg',
          content: finalImageAttachment,
          contentId: 'skin-map'
        }
      ]
    });

    if (emailError) {
      throw new Error('Erreur Resend: ' + JSON.stringify(emailError));
    }

    return res.status(200).json({
      success: true,
      taskId,
      scores,
      drawnMasks,
      outputTypes: outputs.map((output) => output.type),
      emailId: emailData?.id
    });
  } catch (error) {
    console.error('Erreur durant le traitement:', error);

    return res.status(500).json({
      error: error.message
    });
  }
}