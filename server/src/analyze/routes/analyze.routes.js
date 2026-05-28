import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  validateAnalyzeBody,
  validateBranchQuery,
  validateLocalPathBody,
  validatePublicRepoBody,
  validateRepoBrowserQuery,
  validateRepoFileQuery,
  validateRepoFileUpdateBody,
} from '../middleware/validate.middleware.js';
import {
  analyzeController,
  browseLocalPathController,
  getRepositoryFileController,
  listAnalysisHistoryController,
  listBranchesController,
  listRepositoryDirectoryController,
  listRepositoryStructureController,
  listOwnedReposController,
  localPickerCapabilitiesController,
  resolvePublicRepoController,
  updateRepositoryFileController,
  validateLocalPathController,
  createPrCommitController,
} from '../controllers/analyze.controller.js';

const router = Router();

const analyzeLimiter = rateLimit({
  windowMs:       60 * 1000,
  max:            30,
  standardHeaders: true,
  legacyHeaders:  false,
  message:        { error: 'Too many requests. Please wait a moment and try again.' },
});

router.post('/', analyzeLimiter, validateAnalyzeBody, analyzeController);
router.get('/local/picker-capabilities', analyzeLimiter, localPickerCapabilitiesController);
router.get('/history', analyzeLimiter, listAnalysisHistoryController);
router.get('/local/browse', analyzeLimiter, browseLocalPathController);
router.post('/local/validate', analyzeLimiter, validateLocalPathBody, validateLocalPathController);
router.post('/github/public/resolve', analyzeLimiter, validatePublicRepoBody, resolvePublicRepoController);
router.get('/github/repos', analyzeLimiter, listOwnedReposController);
router.get('/github/branches', analyzeLimiter, validateBranchQuery, listBranchesController);
router.get('/github/structure', analyzeLimiter, validateRepoBrowserQuery, listRepositoryStructureController);
router.get('/github/contents', analyzeLimiter, validateRepoBrowserQuery, listRepositoryDirectoryController);
router.get('/github/file', analyzeLimiter, validateRepoFileQuery, getRepositoryFileController);
router.put('/github/file', analyzeLimiter, validateRepoFileUpdateBody, updateRepositoryFileController);
router.post('/commit', analyzeLimiter, createPrCommitController);

export default router;
