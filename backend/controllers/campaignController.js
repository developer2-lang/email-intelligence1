/**
 * Campaign route handlers.
 *
 * Thin controllers that validate input, delegate to the campaign workflow
 * service, and return a consistent JSON envelope.
 */
import * as campaignService from '../services/campaignService.js';
import { supabase } from '../services/supabaseService.js';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

// ─── Frontend-compatible one-step endpoints ────────────────────────────────

async function sendCampaign(req, res, next) {
  try {
    console.log('[Campaign] POST /api/campaigns/send — request received');
    console.log('[Campaign] Payload:', JSON.stringify(req.body, null, 2));

    const result = await campaignService.sendCampaignFlow(req.body || {});

    console.log('[Campaign] sendCampaignFlow completed:', JSON.stringify(result));
    res.json({ success: true, message: 'Campaign sent successfully.', data: result });
  } catch (error) {
    console.error('[Campaign] sendCampaign FAILED');
    console.error('[Campaign] Error:', error.message);
    console.error('[Campaign] Stack:', error.stack);
    next(error);
  }
}

async function scheduleCampaign(req, res, next) {
  try {
    console.log('[Campaign] POST /api/campaigns/schedule — request received');
    console.log('[Campaign] Payload:', JSON.stringify(req.body, null, 2));

    const result = await campaignService.scheduleCampaignFlow(req.body || {});

    console.log('[Campaign] scheduleCampaignFlow completed:', JSON.stringify(result));
    res.json({ success: true, message: 'Campaign scheduled successfully.', data: result });
  } catch (error) {
    console.error('[Campaign] scheduleCampaign FAILED');
    console.error('[Campaign] Error:', error.message);
    console.error('[Campaign] Stack:', error.stack);
    next(error);
  }
}

async function saveDraft(req, res, next) {
  try {
    console.log('[Campaign] POST /api/campaigns/draft — request received');

    const result = await campaignService.saveDraftFlow(req.body || {});

    console.log('[Campaign] saveDraftFlow completed:', JSON.stringify(result));
    res.status(201).json({ success: true, message: 'Campaign saved as draft.', data: result });
  } catch (error) {
    console.error('[Campaign] saveDraft FAILED');
    console.error('[Campaign] Error:', error.message);
    console.error('[Campaign] Stack:', error.stack);
    next(error);
  }
}

// ─── RESTful CRUD ─────────────────────────────────────────────────────────

async function listCampaigns(req, res, next) {
  try {
    const data = await campaignService.listCampaignsFlow();
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Campaign] listCampaigns FAILED:', error.message);
    next(error);
  }
}

async function getCampaign(req, res, next) {
  try {
    const data = await campaignService.getCampaignFlow(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Campaign] getCampaign FAILED:', error.message);
    next(error);
  }
}

async function createCampaign(req, res, next) {
  try {
    const data = await campaignService.createCampaignFlow(req.body || {});
    res.status(201).json({ success: true, message: 'Campaign created.', data });
  } catch (error) {
    console.error('[Campaign] createCampaign FAILED:', error.message);
    next(error);
  }
}

async function updateCampaign(req, res, next) {
  try {
    const data = await campaignService.updateCampaignFlow(req.params.id, req.body || {});
    res.json({ success: true, message: 'Campaign updated.', data });
  } catch (error) {
    console.error('[Campaign] updateCampaign FAILED:', error.message);
    next(error);
  }
}

async function deleteCampaign(req, res, next) {
  try {
    await campaignService.deleteCampaignFlow(req.params.id);
    res.json({ success: true, message: 'Campaign deleted.' });
  } catch (error) {
    console.error('[Campaign] deleteCampaign FAILED:', error.message);
    next(error);
  }
}

// ─── Send / Schedule existing campaign ────────────────────────────────────

async function sendCampaignById(req, res, next) {
  try {
    const result = await campaignService.sendExistingCampaignFlow(req.params.id);
    res.json({ success: true, message: 'Campaign is being sent.', data: result });
  } catch (error) {
    console.error('[Campaign] sendCampaignById FAILED:', error.message);
    next(error);
  }
}

async function scheduleCampaignById(req, res, next) {
  try {
    const { schedule_date, schedule_time } = req.body || {};
    if (!schedule_date || !schedule_time) {
      const err = new Error('schedule_date and schedule_time are required');
      err.status = 400;
      throw err;
    }
    const result = await campaignService.scheduleExistingCampaignFlow(
      req.params.id,
      schedule_date,
      schedule_time
    );
    res.json({ success: true, message: 'Campaign scheduled.', data: result });
  } catch (error) {
    console.error('[Campaign] scheduleCampaignById FAILED:', error.message);
    next(error);
  }
}

async function uploadImage(req, res, next) {
  try {
    const { filename, data, contentType } = req.body || {};
    if (!filename || !data || !contentType) {
      const err = new Error('filename, data (base64), and contentType are required');
      err.status = 400;
      throw err;
    }

    const buffer = Buffer.from(data, 'base64');
    const path = `images/${Date.now()}-${randomUUID()}.${filename.split('.').pop() || 'png'}`;

    const { error: uploadError } = await supabase.storage
      .from('email-template')
      .upload(path, buffer, {
        cacheControl: '3600',
        contentType: contentType || 'image/png',
        upsert: false,
      });

    if (uploadError) {
      throw new Error(`Failed to upload image: ${uploadError.message}`);
    }

    const { data: urlData } = supabase.storage.from('email-template').getPublicUrl(path);
    if (!urlData?.publicUrl) {
      throw new Error('Could not resolve the uploaded image URL.');
    }

    res.json({ success: true, url: urlData.publicUrl });
  } catch (error) {
    next(error);
  }
}

export {
  sendCampaign,
  scheduleCampaign,
  saveDraft,
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  sendCampaignById,
  scheduleCampaignById,
  uploadImage,
};
