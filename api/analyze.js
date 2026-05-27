import { createCanvas, loadImage } from '@napi-rs/canvas';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '12mb'
    }
  }
};

const PERFECT_API_VERSION = process.env.PERFECT_API_VERSION || 'v2.1';
const PERFECT_API_BASE = `https://yce-api-01.makeupar.com/s2s/${PERFECT_API_VERSION}`;

const KLAVIYO_REVISION = process.env.KLAVIYO_REVISION || '2026-04-15';
const KLAVIYO_EVENT_NAME = 'Diagnostic de Peau termine';

const ANALYSIS_ACTIONS = [
  { type: 'acne', scoreKey: 'acne', color: '#b700ff', opacity: 0.70 },
  { type: 'pore', scoreKey: 'pore', color: '#00ff6a', opacity: 0.70 },
  { type: 'age_spot', scoreKey: 'spots', color: '#ffcc00', opacity: 0.70 },
  { type: 'wrinkle', scoreKey: 'wrinkle', color: '#ff1900', opacity: 0.70 }
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

async function resizeImageIfTooSmall(cleanImage) {
  const img = await loadImage(cleanImage.dataUrl);

  const minShortSide = 480;
  const shortSide = Math.min(img.width, img.height);

  if (shortSide >= minShortSide) {
    return cleanImage;
  }

  const scale = minShortSide / shortSide;
  const newWidth = Math.round(img.width * scale);
  const newHeight = Math.round(img.height * scale);

  const canvas = createCanvas(newWidth, newHeight);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(img, 0, 0, newWidth, newHeight);

  const resizedDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const resizedBase64 = resizedDataUrl.split(',')[1];
  const resizedBuffer = Buffer.from(resizedBase64, 'base64');

  return {
    contentType: 'image/jpeg',
    extension: 'jpg',
    base64Data: resizedBase64,
    imageBuffer: resizedBuffer,
    dataUrl: resizedDataUrl
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
    throw new Error('Aucun output JSON exploitable: ' + JSON.stringify(taskData));
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

async function uploadImageToKlaviyo(dataUrl) {
  const response = await fetch('https://a.klaviyo.com/api/images', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_API_KEY}`,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      revision: KLAVIYO_REVISION
    },
    body: JSON.stringify({
      data: {
        type: 'image',
        attributes: {
          import_from_url: dataUrl,
          name: `diagnostic-peau-${Date.now()}.jpg`,
          hidden: true
        }
      }
    })
  });

  const data = await readJson(response, 'Upload image Klaviyo');
  const imageUrl = data.data?.attributes?.image_url;

  if (!imageUrl) {
    throw new Error('Aucune image_url Klaviyo: ' + JSON.stringify(data));
  }

  return imageUrl;
}

async function sendKlaviyoDiagnosticEvent(email, scores, cartographieUrl, taskId, drawnMasks) {
  const response = await fetch('https://a.klaviyo.com/api/events', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_PRIVATE_API_KEY}`,
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      revision: KLAVIYO_REVISION
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: {
            data: {
              type: 'metric',
              attributes: {
                name: KLAVIYO_EVENT_NAME
              }
            }
          },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email
              }
            }
          },
          properties: {
            cartographie_url: cartographieUrl,
            score_acne: scores.acne,
            score_pores: scores.pore,
            score_taches: scores.spots,
            score_rides: scores.wrinkle,
            perfect_corp_task_id: taskId,
            zones_detectees: drawnMasks
          },
          unique_id: `${email}-${taskId}-${Date.now()}`
        }
      }
    })
  });

  if (response.status !== 202) {
    const text = await response.text();
    throw new Error(`Event Klaviyo echoue (${response.status}): ${text.slice(0, 1000)}`);
  }
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
    if (!process.env.PERFECT_CORP_SECRET_KEY) {
      throw new Error('PERFECT_CORP_SECRET_KEY manquante');
    }

    if (!process.env.KLAVIYO_PRIVATE_API_KEY) {
      throw new Error('KLAVIYO_PRIVATE_API_KEY manquante');
    }

    const { email, image } = req.body || {};

    if (!email || !String(email).includes('@')) {
      return res.status(400).json({ error: 'Email invalide' });
    }
    

    let cleanImage = cleanInputImage(image);
    cleanImage = await resizeImageIfTooSmall(cleanImage);

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

    const finalImageBase64 = canvas.toDataURL('image/jpeg', 0.86);

    const scores = {
      acne: getScore(outputs, 'acne'),
      pore: getScore(outputs, 'pore'),
      spots: getScore(outputs, 'age_spot'),
      wrinkle: getScore(outputs, 'wrinkle')
    };

    const cartographieUrl = await uploadImageToKlaviyo(finalImageBase64);

    await sendKlaviyoDiagnosticEvent(email, scores, cartographieUrl, taskId, drawnMasks);

    return res.status(200).json({
      success: true,
      provider: 'klaviyo',
      eventName: KLAVIYO_EVENT_NAME,
      taskId,
      scores,
      cartographieUrl,
      drawnMasks
    });
  } catch (error) {
    console.error('Erreur durant le traitement:', error);

    return res.status(500).json({
      error: error.message
    });
  }
}