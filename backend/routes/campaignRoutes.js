/**
 * Campaign workflow API routes.
 *
 * Mounted at /api/campaigns in server.js.
 *
 * Frontend-compatible (one-step):
 *   POST /api/campaigns/send       Create + send immediately.
 *   POST /api/campaigns/schedule   Create + schedule.
 *   POST /api/campaigns/draft      Save as draft.
 *
 * RESTful CRUD:
 *   GET    /api/campaigns           List all campaigns.
 *   GET    /api/campaigns/:id       Campaign details + email logs.
 *   POST   /api/campaigns           Create a campaign (save only).
 *   PATCH  /api/campaigns/:id       Update a campaign.
 *   DELETE /api/campaigns/:id       Delete a campaign.
 *   POST   /api/campaigns/:id/send     Send an existing campaign.
 *   POST   /api/campaigns/:id/schedule Schedule an existing campaign.
 */
import express from 'express';
import * as controller from '../controllers/campaignController.js';
import * as followupController from '../controllers/followupController.js';
import { uploadImage } from '../controllers/campaignController.js';

const router = express.Router();

// Fixed routes FIRST — these must match before the /:id param routes.
router.post('/send', controller.sendCampaign);
router.post('/schedule', controller.scheduleCampaign);
router.post('/draft', controller.saveDraft);
router.post('/upload-image', controller.uploadImage);

// RESTful CRUD.
router.get('/', controller.listCampaigns);
router.post('/', controller.createCampaign);
router.get('/:id', controller.getCampaign);
router.patch('/:id', controller.updateCampaign);
router.delete('/:id', controller.deleteCampaign);

// Send / Schedule an existing campaign.
router.post('/:id/send', controller.sendCampaignById);
router.post('/:id/schedule', controller.scheduleCampaignById);

// Follow-up automation config for a campaign.
router.get('/:id/followup', followupController.getFollowupConfig);
router.post('/:id/followup', followupController.saveFollowupConfig);

// Opened contacts for a campaign + manual-mode bulk send.
router.get('/:id/opened-contacts', followupController.getOpenedContacts);
router.post('/:id/followup/send-selected', followupController.sendSelectedFollowups);

// GET on POST-only endpoints returns 405.
router.get('/send', methodNotAllowed);
router.get('/schedule', methodNotAllowed);
router.get('/draft', methodNotAllowed);

function methodNotAllowed(req, res) {
  res.status(405).json({
    success: false,
    error: {
      status: 405,
      message: `Method ${req.method} not allowed for ${req.originalUrl}. Use POST with a JSON body.`,
    },
  });
}

export default router;
