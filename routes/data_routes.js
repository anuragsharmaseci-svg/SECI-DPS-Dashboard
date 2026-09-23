const express = require("express");
const router = express.Router();
const dataController = require("../controllers/data_controllers");
const { verifyToken, verifyAdmin } = require("../middleware/verify_token");
const { requireDeptEditAccess } = require("../middleware/require_dept_edit_access");
const { requireDeptHeadAccess } = require("../middleware/require_dept_head_access");
const auditLogger = require("../middleware/audit_logger");
const multer = require("multer");
const path = require("path");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "..", "uploads")),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const allowedMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
];

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit
  fileFilter: (req, file, cb) => {
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only PDF, images, documents, and spreadsheets are allowed."), false);
    }
  },
});

// --- Read-only data-fetch POST routes (before requireDeptEditAccess so viewers can access them) ---

router.post(
  "/om/solar_bess/date/one",
  verifyToken,
  auditLogger("Fetched the OM Solar+BESS data for a specific date"),
  dataController.getOMSolarBESSDataForDate,
);

router.post(
  "/om/solar/date/one",
  verifyToken,
  auditLogger("Fetched the OM Solar data for a specific date"),
  dataController.getOMSolarDataForDate,
);

router.use(requireDeptEditAccess);

// Get PMC donut chart data
router.get(
  "/pmc/chart-data",
  verifyToken,
  auditLogger("Viewed PMC donut chart data"),
  dataController.getPmcDonutChartData
);

// get all milestones for a specific entry
router.get(
  "/bd/milestone/one/:bd_entry_id",
  verifyToken,
  auditLogger("Viewed milestones for a Business Development entry"),
  dataController.getMilestonesByBusinessDevelopmentEntry,
);

router.put(
  "/bd/entry/edit/:bd_entry_id",
  verifyToken,
  auditLogger("Edited a Business Development entry"),
  dataController.editBusinessDevelopmentEntry,
);

router.put(
  "/bd/milestone/edit/:milestone_id",
  verifyToken,
  auditLogger("Edited a Business Development milestone"),
  dataController.editBusinessDevelopmentMilestone,
);

// get all business development entries
router.get(
  "/bd/entry/all",
  verifyToken,
  auditLogger("Viewed all entries in Business Development"),
  dataController.getAllBusinessDevelopmentEntries,
);

router.delete(
  "/bd/milestone/delete/:milestone_id",
  verifyToken,
  auditLogger("Deleted a Business Development milestones"),
  dataController.deleteBusinessDevelopmentMilestone,
);

router.delete(
  "/bd/entry/delete/:bd_entry_id",
  verifyToken,
  auditLogger("Deleted a business development entry"),
  dataController.deleteBusinessDevelopmentEntry,
);

// add a business development milestone
router.post(
  "/bd/milestone/add",
  verifyToken,
  auditLogger("Added entry in Business Development"),
  dataController.createBusinessDevelopmentMilestone,
);

// add a business development entry
router.post(
  "/bd/entry/add",
  verifyToken,
  auditLogger("Added entry in Business Development"),
  dataController.createBusinessDevelopmentEntry,
);

// ──────────────────────────────────────────────
// C&P Own Projects routes
// ──────────────────────────────────────────────

// get all C&P own projects
router.get(
  "/cp/entry/all",
  verifyToken,
  auditLogger("Viewed all C&P own projects"),
  dataController.getAllCpOwnProjects,
);

// get one C&P own project
router.get(
  "/cp/entry/one/:cp_entry_id",
  verifyToken,
  auditLogger("Viewed a C&P own project"),
  dataController.getOneCpOwnProject,
);

// add a C&P own project
router.post(
  "/cp/entry/add",
  verifyToken,
  auditLogger("Added a C&P own project"),
  dataController.createCpOwnProject,
);

// edit a C&P own project
router.put(
  "/cp/entry/edit/:cp_entry_id",
  verifyToken,
  auditLogger("Edited a C&P own project"),
  dataController.editCpOwnProject,
);

// delete a C&P own project
router.delete(
  "/cp/entry/delete/:cp_entry_id",
  verifyToken,
  auditLogger("Deleted a C&P own project"),
  dataController.deleteCpOwnProject,
);

// PMC entries
router.get(
  "/pmc/entry/all",
  verifyToken,
  auditLogger("Viewed all PMC entries"),
  dataController.getAllPmcEntries,
);

router.get(
  "/pmc/entry/one/:pmc_entry_id",
  verifyToken,
  auditLogger("Viewed a PMC entry"),
  dataController.getPmcEntryById,
);

router.post(
  "/pmc/entry/add",
  verifyToken,
  auditLogger("Added a PMC entry"),
  dataController.createPmcEntry,
);

router.put(
  "/pmc/entry/edit/:pmc_entry_id",
  verifyToken,
  auditLogger("Edited a PMC entry"),
  dataController.editPmcEntry,
);

router.delete(
  "/pmc/entry/delete/:pmc_entry_id",
  verifyToken,
  auditLogger("Deleted a PMC entry"),
  dataController.deletePmcEntry,
);

// PMC Consultancy & Engineering Entities routes
router.get(
  "/pmc/ce/entities/all",
  verifyToken,
  auditLogger("Fetched all PMC C&E entities"),
  dataController.getAllPmcCEEntities,
);

router.post(
  "/pmc/ce/entities/save",
  verifyToken,
  auditLogger("Saved PMC C&E entities"),
  dataController.savePmcCEEntities,
);

// PMC slice metadata (DPR/PFR, BMS, etc.) - full-stack categorization
router.get(
  "/pmc/slice_meta/:segment",
  verifyToken,
  auditLogger("Viewed PMC slice metadata"),
  dataController.getPmcSliceMetaBySegment,
);

router.post(
  "/pmc/slice_meta/save",
  verifyToken,
  requireDeptHeadAccess,
  auditLogger("Saved PMC slice metadata"),
  dataController.savePmcSliceMeta,
);

// PMC slice editor routes (moved from pmc_slice_routes.js)
router.get(
  "/pmc/slice_editor/segment/:segment",
  verifyToken,
  dataController.getPmcSliceMetaBySegment,
);

router.post(
  "/pmc/slice_editor/save",
  verifyToken,
  requireDeptHeadAccess,
  dataController.savePmcSliceMeta,
);

router.delete(
  "/pmc/slice_editor/item/:id",
  verifyToken,
  requireDeptHeadAccess,
  dataController.deletePmcSliceMetaItem,
);

router.post(
  "/pmc/slice_editor/cleanup",
  verifyToken,
  dataController.cleanupPmcExecution,
);

// Legacy-compatible aliases from pmc_slice_routes.js
router.get(
  "/pmc_slice/segment/:segment",
  verifyToken,
  dataController.getPmcSliceMetaBySegment,
);

router.post(
  "/pmc_slice/save",
  verifyToken,
  requireDeptHeadAccess,
  dataController.savePmcSliceMeta,
);

router.post(
  "/pmc_slice/cleanup",
  verifyToken,
  dataController.cleanupPmcExecution,
);

// PMC C&E Milestone routes (moved from pmc_ce_milestone_routes.js)
router.get(
  "/pmc/ce/milestones/all/:pmc_ce_entity_id",
  verifyToken,
  auditLogger("Viewed PMC C&E milestones"),
  dataController.getPmcCeMilestones
);

router.get(
  "/pmc/ce/milestones/one/:pmc_ce_milestone_id",
  verifyToken,
  auditLogger("Viewed a PMC C&E milestone"),
  dataController.getPmcCeMilestoneById
);

router.post(
  "/pmc/ce/milestones/add",
  verifyToken,
  auditLogger("Added a PMC C&E milestone"),
  dataController.createPmcCeMilestone
);

router.put(
  "/pmc/ce/milestones/edit/:pmc_ce_milestone_id",
  verifyToken,
  auditLogger("Edited a PMC C&E milestone"),
  dataController.updatePmcCeMilestone
);

router.delete(
  "/pmc/ce/milestones/delete/:pmc_ce_milestone_id",
  verifyToken,
  auditLogger("Deleted a PMC C&E milestone"),
  dataController.deletePmcCeMilestone
);

router.post(
  "/pmc/ce/milestones/bulk-save",
  verifyToken,
  auditLogger("Bulk saved PMC C&E milestones"),
  dataController.bulkSavePmcCeMilestones
);

// Legacy-compatible aliases from pmc_ce_milestone_routes.js
router.get(
  "/pmc_ce_milestone/all/:pmc_ce_entity_id",
  verifyToken,
  auditLogger("Viewed PMC C&E milestones"),
  dataController.getPmcCeMilestones
);

router.get(
  "/pmc_ce_milestone/one/:pmc_ce_milestone_id",
  verifyToken,
  auditLogger("Viewed a PMC C&E milestone"),
  dataController.getPmcCeMilestoneById
);

router.post(
  "/pmc_ce_milestone/add",
  verifyToken,
  auditLogger("Added a PMC C&E milestone"),
  dataController.createPmcCeMilestone
);

router.put(
  "/pmc_ce_milestone/edit/:pmc_ce_milestone_id",
  verifyToken,
  auditLogger("Edited a PMC C&E milestone"),
  dataController.updatePmcCeMilestone
);

router.delete(
  "/pmc_ce_milestone/delete/:pmc_ce_milestone_id",
  verifyToken,
  auditLogger("Deleted a PMC C&E milestone"),
  dataController.deletePmcCeMilestone
);

router.post(
  "/pmc_ce_milestone/bulk-save",
  verifyToken,
  auditLogger("Bulk saved PMC C&E milestones"),
  dataController.bulkSavePmcCeMilestones
);

router.get(
  "/pmc/ce/context/:project_name",
  verifyToken,
  auditLogger("Resolved PMC C&E context by project label"),
  dataController.getPmcCEEntityContextByLabel,
);

// Tariff values (requested/approved) per dept/statistic/entity context
router.get(
  "/tariff-values/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed tariff values for context"),
  dataController.getTariffValues,
);

router.post(
  "/tariff-values/save",
  verifyToken,
  auditLogger("Saved tariff values for context"),
  dataController.saveTariffValues,
);

// Resolve PMC C&E context using pmc_ce_entity_id
router.get(
  "/pmc/ce/context/id/:pmc_ce_entity_id",
  verifyToken,
  auditLogger("Resolved PMC C&E context by entity ID"),
  dataController.getPmcCEEntityContextById,
);

// Resolve dept/statistic for an entity when only entity_id is available
router.get(
  "/entities/context/:entity_id",
  verifyToken,
  auditLogger("Resolved entity context by entity_id"),
  dataController.getEntityContextById,
);

// PMC C&E - dedicated documents & correspondences endpoints (JSON)
router.get(
  "/pmc/ce/documents/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed PMC C&E documents"),
  dataController.getPmcCeDocuments,
);

router.post(
  "/pmc/ce/documents",
  verifyToken,
  auditLogger("Added PMC C&E document"),
  dataController.createPmcCeDocument,
);

router.delete(
  "/pmc/ce/documents/:pmc_ce_doc_id",
  verifyToken,
  auditLogger("Deleted PMC C&E document"),
  dataController.deletePmcCeDocument,
);

router.get(
  "/pmc/ce/correspondences/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed PMC C&E correspondences"),
  dataController.getPmcCeCorrespondences,
);

router.post(
  "/pmc/ce/correspondences",
  verifyToken,
  auditLogger("Added PMC C&E correspondence"),
  dataController.createPmcCeCorrespondence,
);

router.delete(
  "/pmc/ce/correspondences/:pmc_ce_corr_id",
  verifyToken,
  auditLogger("Deleted PMC C&E correspondence"),
  dataController.deletePmcCeCorrespondence,
);

// Contracts Table related routes
router.post(
  "/contracts/add",
  verifyToken,
  auditLogger("Added and entry in the contracts table"),
  dataController.createEntryInContractsTable,
);

router.get(
  "/contracts/all",
  verifyToken,
  auditLogger("Viewed all contract table entries"),
  dataController.getEntriesFromContractsTable,
);

router.delete(
  "/contracts/remove/:entry_id",
  verifyToken,
  auditLogger("Deleted an entry from the contract table"),
  dataController.deleteEntryFromContractsTable,
);

router.post(
  "/contracts/tenders/upload",
  verifyToken,
  upload.single("excelFile"),
  auditLogger("Uploaded contract tender register Excel"),
  dataController.uploadTenderRegisterExcel,
);

router.get(
  "/contracts/tenders/all",
  verifyToken,
  auditLogger("Viewed contract tender register entries"),
  dataController.getTenderRegisters,
);

router.get(
  "/contracts/tenders/summary",
  verifyToken,
  auditLogger("Viewed contract tender register summary"),
  dataController.getTenderRegisterSummary,
);

router.get(
  "/contracts/tenders/download",
  verifyToken,
  auditLogger("Downloaded contract tender register Excel"),
  dataController.downloadTenderRegisterExcel,
);

router.get(
  "/contracts/tenders/upload-date",
  verifyToken,
  auditLogger("Viewed contract tender register upload date"),
  dataController.getTenderRegisterUploadDate,
);

router.get(
  "/mapping/all",
  verifyToken,
  verifyAdmin,
  auditLogger("Viewed all department to user mappings"),
  dataController.getUserDepartmentMappings,
);

// Departments
router.post(
  "/departments/create",
  verifyToken,
  verifyAdmin,
  auditLogger("Created a new department"),
  dataController.createDepartment,
);
router.get(
  "/departments/user/:user_id",
  verifyToken,
  auditLogger("Viewed departments assigned to a user"),
  dataController.getDepartmentsForUser,
);
router.get(
  "/departments/:dept_id",
  verifyToken,
  auditLogger("Viewed department details"),
  dataController.getDepartmentDetails,
);
router.get(
  "/departments",
  verifyToken,
  verifyAdmin,
  dataController.getAllDepartments,
);
router.post(
  "/departments",
  verifyToken,
  auditLogger("Added a new department"),
  dataController.addDepartment,
);
router.put(
  "/departments/:dept_id",
  verifyToken,
  auditLogger("Edited department details"),
  dataController.editDepartment,
);
router.delete(
  "/departments/:dept_id",
  verifyToken,
  verifyAdmin,
  auditLogger("Deleted a department"),
  dataController.deleteDepartment,
);
router.put(
  "/departments/headcount/:dept_id",
  verifyToken,
  verifyAdmin,
  auditLogger("Updated department headcount"),
  dataController.editHeadCount,
);
router.put(
  "/departments/manage/:dept_id",
  verifyToken,
  verifyAdmin,
  auditLogger("Changed department status (enabled/disabled)"),
  dataController.manageDepartment,
);

// Statistics
router.get(
  "/statistics/:dept_id",
  verifyToken,
  auditLogger("Viewed all statistics for a department"),
  dataController.getAllStatistics,
);
router.post(
  "/statistics",
  verifyToken,
  auditLogger("Added a new statistic"),
  dataController.addStatistic,
);
router.put(
  "/statistics/:dept_id/:statistic_id",
  verifyToken,
  auditLogger("Updated statistic details"),
  dataController.editStatistic,
);
router.delete(
  "/statistics/:dept_id/:statistic_id",
  verifyToken,
  auditLogger("Deleted a statistic"),
  dataController.deleteStatistic,
);
router.post(
  "/statistics/home/:dept_id/:statistic_id",
  verifyToken,
  auditLogger("Set statistic to be shown on homepage"),
  dataController.setHomeStatistic,
);

// Entities
router.get(
  "/entities/:dept_id/:statistic_id",
  verifyToken,
  auditLogger("Viewed entities for a department & statistic"),
  dataController.getAllEntities,
);
router.post(
  "/entities",
  verifyToken,
  auditLogger("Added a new entity"),
  dataController.addEntity,
);
router.put(
  "/entities/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Updated entity details"),
  dataController.editEntity,
);
router.delete(
  "/entities/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Deleted an entity"),
  dataController.deleteEntity,
);

// Documents
router.get(
  "/documents/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed documents for an entity"),
  dataController.getAllDocuments,
);
router.get(
  "/documents/single/:dept_id",
  verifyToken,
  auditLogger("Viewed contract-related documents"),
  dataController.getContractDocuments,
);
router.put(
  "/documents/:dept_id/:statistic_id/:entity_id/:doc_id",
  verifyToken,
  auditLogger("Updated a document"),
  dataController.editDocument,
);
router.delete(
  "/documents/:doc_id",
  verifyToken,
  auditLogger("Deleted a document"),
  dataController.deleteDocument,
);
router.get(
  "/documents/grouped/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed grouped documents by statistic"),
  dataController.getGroupedDocumentsByStatistic,
);

router.get(
  "/pmc/ce/grouped/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed grouped PMC C&E details"),
  dataController.getPmcCEGroupedDetails,
);

// Correspondences
router.get(
  "/correspondences/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed correspondences for an entity"),
  dataController.getAllCorrespondences,
);
router.put(
  "/correspondences/:dept_id/:statistic_id/:entity_id/:correspondence_id",
  verifyToken,
  auditLogger("Updated a correspondence"),
  dataController.editCorrespondence,
);
router.delete(
  "/correspondences/:correspondence_id",
  verifyToken,
  auditLogger("Deleted a correspondence"),
  dataController.deleteCorrespondence,
);
router.get(
  "/correspondences/single/:dept_id",
  verifyToken,
  auditLogger("Viewed department-level correspondences"),
  dataController.getCorrespondencesForDepartment,
);

// Issues
router.delete(
  "/issues/:issue_id",
  verifyToken,
  auditLogger("Deleted a reported issue"),
  dataController.deleteIssue,
);

// Fields
router.get(
  "/fields/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed custom fields for an entity"),
  dataController.getFieldsForDepartmentEntityStatistic,
);

// Combined create/edit statistic
router.post(
  "/combined/newstat/:dept_id/:user_id",
  verifyToken,
  auditLogger("Created new statistic with department, entity and fields"),
  dataController.createNewStatisticWithDepartmentEntityFields,
);
router.put(
  "/combined/newstat/:dept_id/:statistic_id",
  verifyToken,
  auditLogger("Edited statistic along with associated data"),
  dataController.editNewStatisticWithDepartmentEntityFields,
);

/**
 * O&M routes
 */

router.get(
  "/om/all/data",
  verifyToken,
  auditLogger("Get O&M Data for particular date"),
  dataController.getOMProjectsByDate,
);

router.post(
  "/om/new/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Created a new entry in O&M"),
  dataController.addOMDGR,
);

router.get(
  "/om/get/filtered/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  auditLogger("Viewed O&M entries for a specific project"),
  dataController.getFilteredActiveOMDGRs,
);

router.delete(
  "/om/remove/:om_dgr_id",
  verifyToken,
  auditLogger("Deleted a DGR in O&M"),
  dataController.deleteOMDGR,
);

router.put(
  "/om/edit/:om_dgr_id",
  verifyToken,
  auditLogger("Edited a DGR in O&M"),
  dataController.editOMDGR,
);

router.get(
  "/reia/documents/all",
  verifyToken,
  auditLogger("Viewed all REIA details"),
  dataController.getREIAData,
);

router.get(
  "/om/mapping/check",
  verifyToken,
  auditLogger("Checked an O&M Project Mapping"),
  dataController.checkOMProjectTypeMapping,
);

router.get(
  "/om/mapping/assign",
  verifyToken,
  auditLogger("Assigned mapping to a project type"),
  dataController.assignOMProjectMapping,
);

router.get(
  "/project/find/name",
  verifyToken,
  auditLogger("Fetched the project name"),
  dataController.getProjectName,
);

router.get(
  "/om/solar_bess/all",
  verifyToken,
  auditLogger("Fetched all OM Solar+BESS entries"),
  dataController.getOAllMSolarBESSData,
);

router.get(
  "/om/solar_bess/last-date",
  verifyToken,
  auditLogger("Fetched latest OM Solar+BESS date for entity"),
  dataController.getOMSolarBESSLatestDate,
);

router.post(
  "/om/solar_bess/data/one/update",
  verifyToken,
  auditLogger("Updated the OM Solar+BESS data for a specific date"),
  dataController.updateOMDGRSolarBESSForOneDate,
);

router.post(
  "/om/solar/data/one/update",
  verifyToken,
  auditLogger("Updated the OM Solar data for a specific date"),
  dataController.updateOMDGRSolarForOneDate,
);

router.get(
  "/om/solar/last-date",
  verifyToken,
  auditLogger("Fetched latest OM Solar date for entity"),
  dataController.getOMSolarLatestDate,
);

router.get(
  "/om/project/capacity",
  verifyToken,
  auditLogger("Get project capacity"),
  dataController.getProjectCapacity,
);

router.get(
  "/om/solar/excel",
  verifyToken,
  auditLogger("Download Excel"),
  dataController.downloadOMSolarExcel,
);

router.get(
  "/om/solar_bess/excel",
  verifyToken,
  auditLogger("Download Excel"),
  dataController.downloadOMSolarBESSExcel,
);

router.get(
  "/get/issues_action",
  verifyToken,
  auditLogger("Get Key Issues and Action Plan"),
  dataController.getIssuesAndActionPlan,
);

router.post(
  "/upsert/issues_action",
  verifyToken,
  auditLogger("Upsert Key Issues and Action Plan"),
  dataController.upsertIssuesAndActionPlan,
);

router.get(
  "/get/all/issues_action",
  // verifyToken,
  auditLogger("Get All Key Issues and Action Plan"),
  dataController.getAllIssuesAndActions,
);

// Developer Payment endpoints
router.get(
  "/developer-payment",
  verifyToken,
  auditLogger("Viewed developer payments"),
  dataController.getAllDeveloperPayments,
);

router.get(
  "/developer-payment/:id",
  verifyToken,
  auditLogger("Viewed a developer payment"),
  dataController.getDeveloperPaymentById,
);

router.post(
  "/developer-payment",
  verifyToken,
  upload.single("file"),
  auditLogger("Added Developer Payment"),
  dataController.createDeveloperPayment,
);

router.put(
  "/developer-payment/:id",
  verifyToken,
  upload.single("file"),
  auditLogger("Edited Developer Payment"),
  dataController.editDeveloperPayment,
);

router.delete(
  "/developer-payment/:id",
  verifyToken,
  auditLogger("Deleted Developer Payment"),
  dataController.deleteDeveloperPayment,
);

// Power Sale endpoints
router.get(
  "/power-sale",
  verifyToken,
  auditLogger("Viewed power sales"),
  dataController.getAllPowerSales,
);

router.get(
  "/power-sale/:id",
  verifyToken,
  auditLogger("Viewed a power sale"),
  dataController.getPowerSaleById,
);

router.post(
  "/power-sale",
  verifyToken,
  upload.single("file"),
  auditLogger("Added Power Sale"),
  dataController.createPowerSale,
);

router.put(
  "/power-sale/:id",
  verifyToken,
  upload.single("file"),
  auditLogger("Edited Power Sale"),
  dataController.editPowerSale,
);

router.delete(
  "/power-sale/:id",
  verifyToken,
  auditLogger("Deleted Power Sale"),
  dataController.deletePowerSale,
);

// DISCOM Payment endpoints (plural path expected by frontend)
router.get(
  "/discom-payments",
  verifyToken,
  auditLogger("Viewed DISCOM payments"),
  dataController.getAllDiscomPayments,
);

router.get(
  "/discom-payments/:id",
  verifyToken,
  auditLogger("Viewed a DISCOM payment"),
  dataController.getDiscomPaymentById,
);

router.post(
  "/discom-payments",
  verifyToken,
  upload.single("file"),
  auditLogger("Added DISCOM Payment"),
  dataController.createDiscomPayment,
);

router.put(
  "/discom-payments/:id",
  verifyToken,
  upload.single("file"),
  auditLogger("Edited DISCOM Payment"),
  dataController.editDiscomPayment,
);

router.delete(
  "/discom-payments/:id",
  verifyToken,
  auditLogger("Deleted DISCOM Payment"),
  dataController.deleteDiscomPayment,
);

// Regulatory Order endpoints (singular path used by frontend)
router.get(
  "/regulatory-order",
  verifyToken,
  auditLogger("Viewed regulatory orders"),
  dataController.getAllRegulatoryOrders,
);

router.get(
  "/regulatory-order/:id",
  verifyToken,
  auditLogger("Viewed a regulatory order"),
  dataController.getRegulatoryOrderById,
);

router.post(
  "/regulatory-order",
  verifyToken,
  upload.single("file"),
  auditLogger("Added Regulatory Order"),
  dataController.createRegulatoryOrder,
);

router.put(
  "/regulatory-order/:id",
  verifyToken,
  upload.single("file"),
  auditLogger("Edited Regulatory Order"),
  dataController.editRegulatoryOrder,
);

router.delete(
  "/regulatory-order/:id",
  verifyToken,
  auditLogger("Deleted Regulatory Order"),
  dataController.deleteRegulatoryOrder,
);

// State Wise Details endpoints
router.get(
  "/state-wise-details",
  verifyToken,
  auditLogger("Viewed state wise details"),
  dataController.getAllStateWiseDetails,
);

router.get(
  "/state-wise-details/:id",
  verifyToken,
  auditLogger("Viewed a state wise detail"),
  dataController.getStateWiseDetailById,
);

router.post(
  "/state-wise-details",
  verifyToken,
  upload.fields([
    { name: "regulations", maxCount: 1 },
    { name: "report", maxCount: 1 },
  ]),
  auditLogger("Added State Wise Detail"),
  dataController.createStateWiseDetail,
);

router.put(
  "/state-wise-details/:id",
  verifyToken,
  upload.fields([
    { name: "regulations", maxCount: 1 },
    { name: "report", maxCount: 1 },
  ]),
  auditLogger("Edited State Wise Detail"),
  dataController.editStateWiseDetail,
);

router.delete(
  "/state-wise-details/:id",
  verifyToken,
  auditLogger("Deleted State Wise Detail"),
  dataController.deleteStateWiseDetail,
);

// ──────────────────────────────────────────────
// QA routes
// ──────────────────────────────────────────────

// Get all QA registered projects
router.get(
  "/qa/projects/all",
  verifyToken,
  auditLogger("Viewed all QA registered projects"),
  dataController.getAllQaRegisteredProjects,
);

// Create a QA registered project (head only)
router.post(
  "/qa/project/add",
  verifyToken,
  requireDeptHeadAccess,
  auditLogger("Added a QA registered project"),
  dataController.createQaRegisteredProject,
);

// Update a QA registered project
router.put(
  "/qa/project/edit/:qa_project_id",
  verifyToken,
  auditLogger("Edited a QA registered project"),
  dataController.editQaRegisteredProject,
);

// Delete a QA registered project
router.delete(
  "/qa/project/delete/:qa_project_id",
  verifyToken,
  auditLogger("Deleted a QA registered project"),
  dataController.deleteQaRegisteredProject,
);

// Get BBU entries for a QA project
router.get(
  "/qa/project/:qa_project_id/bbu/all",
  verifyToken,
  auditLogger("Viewed BBU entries for a QA project"),
  dataController.getQaBbuByProject,
);

// Create a BBU entry for a QA project
router.post(
  "/qa/project/:qa_project_id/bbu/add",
  verifyToken,
  auditLogger("Added a BBU entry for a QA project"),
  dataController.createQaBbu,
);

// Update a BBU entry (edit/head)
router.put(
  "/qa/bbu/edit/:bbu_id",
  verifyToken,
  requireDeptEditAccess,
  auditLogger("Edited a QA BBU entry"),
  dataController.editQaBbu,
);

// Delete a BBU entry (edit/head)
router.delete(
  "/qa/bbu/delete/:bbu_id",
  verifyToken,
  requireDeptEditAccess,
  auditLogger("Deleted a QA BBU entry"),
  dataController.deleteQaBbu,
);

// Upload BBU Excel for a QA project (edit/head)
router.post(
  "/qa/project/:qa_project_id/bbu/upload",
  verifyToken,
  requireDeptEditAccess,
  auditLogger("Uploaded BBU Excel for a QA project"),
  upload.single("bbu_excel"),
  dataController.uploadQaBbuExcel,
);

// Upload MDCC files
router.post(
  "/qa/mdcc/upload-files",
  verifyToken,
  upload.array("files", 20),
  (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(200).json({ success: true, files: [] });
      }
      const files = req.files.map(f => ({
        original_name: f.originalname,
        path: `/uploads/${f.filename}`
      }));
      res.status(200).json({ success: true, files });
    } catch (err) {
      res.status(500).json({ success: false, message: "File upload failed", error: err.message });
    }
  }
);

// Get MDCC entries for a QA project
router.get(
  "/qa/project/:qa_project_id/mdcc/all",
  verifyToken,
  auditLogger("Viewed MDCC entries for a QA project"),
  dataController.getQaMdccByProject,
);

// Create an MDCC entry for a QA project (edit/head)
router.post(
  "/qa/project/:qa_project_id/mdcc/add",
  verifyToken,
  requireDeptEditAccess,
  auditLogger("Added an MDCC entry for a QA project"),
  dataController.createQaMdcc,
);

// Update an MDCC entry (edit/head)
router.put(
  "/qa/mdcc/edit/:mdcc_id",
  verifyToken,
  requireDeptEditAccess,
  auditLogger("Edited a QA MDCC entry"),
  dataController.editQaMdcc,
);

// Delete an MDCC entry (edit/head)
router.delete(
  "/qa/mdcc/delete/:mdcc_id",
  verifyToken,
  requireDeptEditAccess,
  auditLogger("Deleted a QA MDCC entry"),
  dataController.deleteQaMdcc,
);

// Get QA summary
router.get(
  "/qa/summary",
  verifyToken,
  auditLogger("Viewed QA summary"),
  dataController.getQaSummary,
);

module.exports = router;
