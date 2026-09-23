const multer = require("multer");
const path = require("path");
const {
  EntityDocs,
  EntityCorrespondence,
  EntityIssues,
  TariffPetition,
  REIADocuments,
  OMDGR,
  OMDGRSolarBESS,
  OMDGRSolar,
  ContractDocument,
  CorrespondenceOther,
  BmsContractDocument,
  BmsCorrespondenceOther,
  DprContractDocument,
  DprCorrespondenceOther,
  PmcExecutionDocument,
  PmcExecutionCorrespondence,
  PmcExecutionIssue,
  PmcDprIssue,
  PmcBmsIssue,
} = require("../models").models;
const { PmcCeDocument, PmcCeCorrespondence } = require("../models").models;

const { verifyToken } = require("../middleware/verify_token");
const { requireDeptEditAccess } = require("../middleware/require_dept_edit_access");
const XLSX = require("xlsx");
const { v4: uuidv4, v5: uuidv5 } = require("uuid");
const { Op, fn, col, where } = require("sequelize");

const fs = require("fs");
const uploadsDir = path.join(__dirname, "..", "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
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


function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

const EXECUTION_ENTITY_NAMESPACE = "8b58c497-6e6e-4b3c-a59d-0bf40f269f88";

function normalizeProjectKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildExecutionEntityId(projectName) {
  const normalized = normalizeProjectKey(projectName);
  if (!normalized) return null;
  return uuidv5(`pmc-execution:${normalized}`, EXECUTION_ENTITY_NAMESPACE);
}

function isExecutionSliceContext(value) {
  return /^slicectx:pmc-execution:.+$/i.test(String(value || ""));
}

function getProjectNameFromExecutionSliceContext(value) {
  if (!isExecutionSliceContext(value)) return "";
  const parts = String(value).split(":");
  return String(parts.slice(2).join(":") || "").trim();
}

async function resolveExecutionEntityId(input) {
  const bad = (v) => !v || v === "null" || v === "undefined";
  let entityId = input.pmc_entry_id || input.entity_id || null;
  if (!bad(entityId) && isUuid(entityId)) return String(entityId).trim();

  let projectName = String(input.project_name || "").trim();
  if (!projectName && isExecutionSliceContext(entityId)) {
    projectName = getProjectNameFromExecutionSliceContext(entityId);
  }

  const executionEntityId = input.pmc_execution_entity_id || null;

  if (!projectName) {
    if (!bad(executionEntityId) && isUuid(executionEntityId)) return String(executionEntityId).trim();
    return null;
  }

  const stableExecutionId = buildExecutionEntityId(projectName);
  const resolvedPmcIds = await resolvePmcEntryIdsByProjectName_tolerant(projectName);
  if (stableExecutionId && Array.isArray(resolvedPmcIds) && resolvedPmcIds.indexOf(stableExecutionId) !== -1) {
    return stableExecutionId;
  }

  // Prefer stable project-derived UUID for execution context to keep all tabs aligned.
  if (stableExecutionId) return stableExecutionId;
  if (resolvedPmcIds.length) return resolvedPmcIds[0];

  // For project-scoped execution data, enforce stable UUID derived from project name.
  return stableExecutionId;
}

async function resolveExecutionEntityIdsForQuery(input) {
  const bad = (v) => !v || v === "null" || v === "undefined";
  const direct = input.pmc_entry_id || input.entity_id || input.pmc_execution_entity_id || null;
  if (!bad(direct) && isUuid(direct)) return [String(direct).trim()];

  let projectName = String(input.project_name || "").trim();
  if (!projectName && isExecutionSliceContext(direct)) {
    projectName = getProjectNameFromExecutionSliceContext(direct);
  }
  if (!projectName) return [];

  const ids = [];
  const resolvedPmcIds = await resolvePmcEntryIdsByProjectName_tolerant(projectName);
  const fallbackExecutionId = buildExecutionEntityId(projectName);
  if (Array.isArray(resolvedPmcIds) && resolvedPmcIds.length) ids.push(...resolvedPmcIds);
  if (fallbackExecutionId && ids.indexOf(fallbackExecutionId) === -1) ids.push(fallbackExecutionId);
  return ids;
}

function buildBmsSliceContext(projectName) {
  const normalized = String(projectName || '').trim().toLowerCase();
  return normalized ? `slicectx:pmc-bms:${normalized}` : null;
}

function isBmsSliceContext(value) {
  return /^slicectx:pmc-bms:.+$/i.test(String(value || ''));
}

function buildDprSliceContext(projectName) {
  const normalized = String(projectName || '').trim().toLowerCase();
  return normalized ? `slicectx:pmc_dpr:${normalized}` : null;
}

function isDprSliceContext(value) {
  return /^slicectx:pmc[_-]dpr:.+$/i.test(String(value || ''));
}

function getProjectNameFromDprSliceContext(value) {
  if (!isDprSliceContext(value)) return '';
  const parts = String(value).split(':');
  return String(parts.slice(2).join(':') || '').trim();
}

function toPublicUploadPath(filePath) {
  if (!filePath) return null;
  const normalized = String(filePath).replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const uploadsIdx = lower.lastIndexOf('/uploads/');
  if (uploadsIdx >= 0) return normalized.substring(uploadsIdx);
  if (lower.startsWith('uploads/')) return '/' + normalized;
  if (lower.startsWith('/uploads/')) return normalized;
  return normalized.startsWith('/') ? normalized : '/' + normalized;
}

async function resolveDprContext(input) {
  const rawEntity = String(input.entity_id || input.pmc_entry_id || '').trim();
  let projectName = String(input.project_name || '').trim();
  const directUuid = isUuid(rawEntity) ? rawEntity : '';

  if (!projectName && isDprSliceContext(rawEntity)) {
    projectName = getProjectNameFromDprSliceContext(rawEntity);
  }

  if (!projectName && directUuid) {
    try {
      const { PmcProject } = require('../models').models;
      const project = await PmcProject.findByPk(directUuid, {
        attributes: ['project_name'],
        raw: true,
      });
      projectName = String((project && project.project_name) || '').trim();
    } catch (e) {
      console.warn('resolveDprContext lookup by UUID failed:', e.message);
    }
  }

  const idsFromProject = projectName ? await resolvePmcEntryIdsByProjectName_tolerant(projectName) : [];
  const ids = Array.from(new Set([].concat(directUuid ? [directUuid] : [], idsFromProject)));

  return {
    projectName,
    ids,
    rawEntity,
    dprSliceContext: projectName ? buildDprSliceContext(projectName) : '',
  };
}

async function resolvePmcEntryIdByProjectName(projectName) {
  const ids = await resolvePmcEntryIdsByProjectName_tolerant(projectName);
  return ids.length ? ids[0] : null;
}

async function resolvePmcEntryIdsByProjectName(projectName) {
  const name = String(projectName || '').trim();
  if (!name) return [];
  try {
    const { PmcProject } = require('../models').models;
    if (!PmcProject) return [];
    const matches = await PmcProject.findAll({
      where: where(fn('LOWER', col('project_name')), name.toLowerCase()),
      attributes: ['pmc_entry_id'],
      order: [['createdAt', 'DESC']],
      raw: true,
    });
    if (!Array.isArray(matches) || !matches.length) return [];
    const ids = matches
      .map((m) => String((m && m.pmc_entry_id) || '').trim())
      .filter((id) => isUuid(id));
    return Array.from(new Set(ids));
  } catch (e) {
    console.warn('Failed to resolve project by name:', e.message);
    return [];
  }
}

// Tolerant resolver: try normalized comparisons if direct lowercase match fails.
async function resolvePmcEntryIdsByProjectName_tolerant(projectName) {
  const name = String(projectName || '').trim();
  if (!name) return [];
  try {
    const ids = await resolvePmcEntryIdsByProjectName(name);
    if (ids.length) return ids;

    // Fallback: fetch recent projects and compare normalized form (strip non-alphanumerics)
    const { PmcProject } = require('../models').models;
    if (!PmcProject) return [];
    const rows = await PmcProject.findAll({ attributes: ['pmc_entry_id', 'project_name'], order: [['createdAt', 'DESC']], raw: true });
    const target = normalizeProjectKey(name);
    if (!target) return [];
    const matched = rows
      .filter((r) => normalizeProjectKey(r.project_name) === target)
      .map((r) => String(r.pmc_entry_id || '').trim())
      .filter((id) => isUuid(id));
    return Array.from(new Set(matched));
  } catch (e) {
    console.warn('Tolerant resolve failed:', e.message);
    return [];
  }
}

const addDocument = async (req, res) => {
  try {
    console.log("addDocument called");
    console.log("req.body:", req.body);
    console.log(
      "req.file:",
      req.file
        ? { originalname: req.file.originalname, path: req.file.path, size: req.file.size }
        : null,
    );

    const { dept_id, statistic_id, entity_id, doc_name, doc_type, doc_date } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!filePath) {
      console.error("No file uploaded");
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Validate required identifiers - sometimes front-end passes the literal string 'null'
    const bad = (v) => !v || v === "null" || v === "undefined";
    if (bad(dept_id) || bad(statistic_id) || bad(entity_id)) {
      console.error("Missing required identifiers", { dept_id, statistic_id, entity_id });
      return res.status(400).json({ error: "Missing dept_id, statistic_id or entity_id" });
    }

    const name = doc_name && doc_name !== "null" ? doc_name : path.basename(req.file.originalname, path.extname(req.file.originalname));

    const doc = await EntityDocs.create({
      dept_id: dept_id,
      statistic_id: statistic_id,
      entity_id: entity_id,
      doc_name: name,
      doc_type: doc_type || "cdoc",
      doc_path: toPublicUploadPath(filePath),
      doc_date: doc_date || new Date(),
    });

    res.json(doc);
  } catch (err) {
    console.error("addDocument error:", err);
    res.status(500).json({ error: "Failed to add document", detail: err.message });
  }
};

const addCorrespondence = async (req, res) => {
  try {
    console.log("addCorrespondence called");
    console.log("req.body:", req.body);
    console.log(
      "req.file:",
      req.file
        ? { originalname: req.file.originalname, path: req.file.path, size: req.file.size }
        : null,
    );

    const {
      dept_id,
      statistic_id,
      entity_id,
      subject,
      from,
      to,
      correspondence_date,
      correspondence_type,
    } = req.body;
    const filePath = req.file ? req.file.path : null;

    // Validate identifiers
    const bad = (v) => !v || v === "null" || v === "undefined";
    if (bad(dept_id) || bad(statistic_id) || bad(entity_id)) {
      console.error("Missing required identifiers for correspondence", { dept_id, statistic_id, entity_id });
      return res.status(400).json({ error: "Missing dept_id, statistic_id or entity_id" });
    }

    const corr = await EntityCorrespondence.create({
      dept_id: dept_id,
      statistic_id: statistic_id,
      entity_id: entity_id,
      subject: subject,
      from: from,
      to: to,
      doc_name: filePath ? path.basename(req.file.originalname) : null,
      correspondence_date: correspondence_date,
      doc_path: toPublicUploadPath(filePath),
      correspondence_type: correspondence_type,
    });
    res.json(corr);
  } catch (err) {
    console.error("addCorrespondence error:", err);
    res.status(500).json({ error: "Failed to add correspondence", detail: err.message });
  }
};

const addIssue = async (req, res) => {
  try {
    console.log("addIssue called");
    console.log("req.body:", req.body);
    console.log(
      "req.file:",
      req.file
        ? { originalname: req.file.originalname, path: req.file.path, size: req.file.size }
        : null,
    );

    const {
      dept_id,
      statistic_id,
      entity_id,
      issue_description,
      issue_pertaining_to,
      issue_date,
    } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!dept_id || dept_id === "null") {
      console.error("Missing dept_id for issue", { dept_id });
      return res.status(400).json({ error: "Missing dept_id" });
    }

    const issue = await EntityIssues.create({
      dept_id: dept_id,
      statistic_id: statistic_id,
      entity_id: entity_id,
      issue_description: issue_description,
      issue_pertaining_to: issue_pertaining_to,
      issue_date: issue_date,
      issue_doc_path: filePath,
    });
    res.json(issue);
  } catch (err) {
    console.error("addIssue error:", err);
    res.status(500).json({ error: "Failed to add issue", detail: err.message });
  }
};

const updateREIADocument = async (req, res) => {
  try {
    const { reia_doc_type, last_updated_on } = req.body;

    // Validate input
    if (!reia_doc_type || !last_updated_on) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const filePath = req.file ? req.file.path : null;
    const reia_doc_path = filePath ? toPublicUploadPath(filePath) : null; // Persist public path

    // Find the document by ID and update it
    const document = await REIADocuments.findOne({
      where: { reia_doc_type },
    });

    if (!document) {
      return res.status(404).json({ error: "Document not found" });
    }

    // Update the document with the new details
    document.reia_doc_path = reia_doc_path || document.reia_doc_path; // Don't overwrite path if no new file is uploaded
    document.last_updated_on = last_updated_on;

    await document.save(); // Save the updated document

    return res.status(200).json(document);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Internal server error" });
  }
};

const addOMEntriesByExcel = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;
    const filePath = req.file ? req.file.path : null;
    const workbook = XLSX.readFile(filePath);

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    console.log("file uploaded");

    // Convert sheet to JSON
    const jsonData = XLSX.utils.sheet_to_json(sheet, { raw: false });

    // TODO: Add code to add entries using this data

    for (const lineItem of jsonData) {
      console.log("adding entry");

      const date = lineItem.date;
      const generation = lineItem.generation;
      const machine_availability = lineItem.machine_availability;
      const grid_availability = lineItem.grid_availability;
      const cumulative_generation = lineItem.cumulative;
      const radiation = lineItem.radiation;

      function parseDate(dateStr) {
        const [day, month, year] = dateStr
          .split("/")
          .map((num) => parseInt(num, 10));
        return new Date(year, month - 1, day); // JS months are 0-indexed
      }

      if (
        date == null ||
        generation == null ||
        radiation == null ||
        machine_availability == null ||
        grid_availability == null ||
        cumulative_generation == null
      ) {
        return res.status(400).json({ message: "Missing required fields." });
      }

      let parsedDate = parseDate(date);

      let cuf_till_date =
        cumulative_generation /
        (grid_availability * 24.0 * 100.0 * parsedDate.getDate());

      //check if entry for this date exists already
      const existingEntry = await OMDGR.findOne({
        where: {
          date: parsedDate,
        },
      });

      if (existingEntry !== null) {
        continue; //dont add this entry
      }

      const newRecord = await OMDGR.create({
        dept_id,
        statistic_id,
        entity_id,
        date: parsedDate,
        generation,
        radiation,
        machine_availability,
        grid_availability,
        cumulative_generation,
        cuf_till_date,
        is_active: true,
      });
    }

    return res.status(201).json({
      message: "OMDGR excel file uploaded successfully.",
    });
  } catch (error) {
    console.error("Error in addEntriesByExcel:", error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

// ---------- PMC C&E: upload endpoints (multipart) ----------
const addPmcCeDocumentUpload = async (req, res) => {
  try {
    console.log("addPmcCeDocumentUpload called");
    console.log("req.body:", req.body);
    console.log(
      "req.file:",
      req.file
        ? { originalname: req.file.originalname, path: req.file.path, size: req.file.size }
        : null,
    );

    const { dept_id, statistic_id, entity_id, doc_name, doc_type, doc_date } = req.body;
    const filePath = req.file ? req.file.path : null;

    const bad = (v) => !v || v === "null" || v === "undefined";
    if (bad(dept_id) || bad(statistic_id) || bad(entity_id)) {
      return res.status(400).json({ error: "Missing dept/statistic/entity ids" });
    }

    const name = doc_name && doc_name !== "null" ? doc_name : (req.file ? path.basename(req.file.originalname) : null);

    const doc = await PmcCeDocument.create({
      dept_id,
      statistic_id,
      entity_id,
      doc_name: name,
      doc_type: doc_type || "cdoc",
      doc_path: toPublicUploadPath(filePath),
      doc_date: doc_date || new Date(),
    });

    return res.status(201).json(doc);
  } catch (err) {
    console.error("addPmcCeDocumentUpload error:", err);
    return res.status(500).json({ error: "Failed to add PMC C&E document", detail: err.message });
  }
};

const addPmcCeCorrespondenceUpload = async (req, res) => {
  try {
    console.log("addPmcCeCorrespondenceUpload called");
    console.log("req.body:", req.body);
    console.log(
      "req.file:",
      req.file
        ? { originalname: req.file.originalname, path: req.file.path, size: req.file.size }
        : null,
    );

    const { dept_id, statistic_id, entity_id, subject, from, to, correspondence_date, correspondence_type } = req.body;
    const filePath = req.file ? req.file.path : null;

    const bad = (v) => !v || v === "null" || v === "undefined";
    if (bad(dept_id) || bad(statistic_id) || bad(entity_id)) {
      return res.status(400).json({ error: "Missing dept/statistic/entity ids" });
    }

    const corr = await PmcCeCorrespondence.create({
      dept_id,
      statistic_id,
      entity_id,
      subject: subject || null,
      sender: from || null,
      recipient: to || null,
      correspondence_date: correspondence_date || new Date(),
      correspondence_type: correspondence_type || "contractor",
      doc_path: toPublicUploadPath(filePath),
    });

    return res.status(201).json(corr);
  } catch (err) {
    console.error("addPmcCeCorrespondenceUpload error:", err);
    return res.status(500).json({ error: "Failed to add PMC C&E correspondence", detail: err.message });
  }
};

const upsertOMSolarBESSData = async (req, res) => {
  function convertDDMMYYYY(dateStr) {
    const [day, month, year] = dateStr.split("/");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  try {
    const { dept_id, statistic_id, entity_id } = req.query;
    const filePath = req.file ? req.file.path : null;
    const workbook = XLSX.readFile(filePath);

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const jsonData = XLSX.utils.sheet_to_json(sheet, {
      raw: false,
      cellDates: true,
    });

    for (let i = 0; i < jsonData.length; i++) {
      try {
        jsonData[i].dept_id = dept_id;
        jsonData[i].statistic_id = statistic_id;
        jsonData[i].entity_id = entity_id;
        jsonData[i].date = convertDDMMYYYY(jsonData[i].date);

        //check if the entry for the same date exists already
        const foundEntryForThisDate = await OMDGRSolarBESS.findAll({
          where: { date: jsonData[i].date },
        });

        if (foundEntryForThisDate.length === 0) {
          //create the entry only if it does not exist for this date
          await OMDGRSolarBESS.create(jsonData[i]);
        }
      } catch (error) {
        // console.error(jsonData[i].date);
        continue;
      }
    }

    return res.status(200).json({
      message: "Upserted Solar+BESS data",
    });
  } catch (error) {
    return res.status(500).json({
      message: "Internal Server Erro",
    });
  }
};

const validateSolarRowTypes = (row) => {
  const errors = [];

  const numericFields = [
    "days",
    "generation",
    "radiation",
    "machine_availability",
    "grid_availability",
    "peak_power",
    "cumulative_generation",
    "cuf",
    "cuf_till_date",
  ];

  // date validation
  if (!row.date || typeof row.date !== "string") {
    errors.push({
      field: "date",
      value: row.date,
      type: typeof row.date,
      expected: "DD/MM/YYYY (string)",
    });
  }

  // numeric fields validation
  for (const field of numericFields) {
    if (!isNumber(row[field])) {
      errors.push({
        field,
        value: row[field],
        type: typeof row[field],
        expected: "number",
      });
    }
  }

  return errors;
};

const uploadOMSolarFromExcel = async (req, res) => {
  try {
    console.log("Solar, Upload from excel called");

    const { dept_id, statistic_id, entity_id } = req.query;

    if (!dept_id || !statistic_id || !entity_id) {
      return res.status(400).json({
        message: "dept_id, statistic_id and entity_id are required",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        message: "Excel file is required",
      });
    }

    /* ---------- Read Excel ---------- */
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const rows = XLSX.utils.sheet_to_json(sheet, {
      raw: false,
      defval: null,
    });

    if (!rows.length) {
      return res.status(400).json({ message: "Excel file is empty" });
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    /* ---------- Process Rows ---------- */
    for (const row of rows) {
      try {
        const typeErrors = validateSolarRowTypes(row);

        if (typeErrors.length) {
          console.error("❌ Datatype mismatch found:");
          console.table(typeErrors);
          console.error("Row data:", row);
          skipped++;
          continue;
        }

        const normalizedDate = normalizeDate(row.date);

        /* ---------- Check Existing Record ---------- */
        const existingRecord = await OMDGRSolar.findOne({
          where: {
            dept_id,
            statistic_id,
            entity_id,
            date: normalizedDate,
          },
        });

        const payload = {
          days: row.days,
          generation: row.generation,
          radiation: row.radiation,
          machine_availability: row.machine_availability,
          grid_availability: row.grid_availability,
          peak_power: row.peak_power,
          cumulative_generation: row.cumulative_generation,
          cuf: row.cuf,
          cuf_till_date: row.cuf_till_date,
          remarks: row.remarks || null,
          is_active: 1,
        };

        if (existingRecord) {
          /* ---------- UPDATE ---------- */
          await existingRecord.update(payload);
          updated++;
        } else {
          /* ---------- INSERT ---------- */
          await OMDGRSolar.create({
            dept_id,
            statistic_id,
            entity_id,
            om_dgr_solar_id: uuidv4(),
            date: normalizedDate,
            ...payload,
          });
          inserted++;
        }
      } catch (rowError) {
        console.error("Row failed:", row, rowError.message);
        skipped++;
      }
    }

    return res.status(200).json({
      message: "OM Solar Excel processed successfully",
      summary: {
        totalRows: rows.length,
        inserted,
        updated,
        skipped,
      },
    });
  } catch (error) {
    console.error("Excel Upload Error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
    });
  }
};

const validateSolarBessRowTypes = (row) => {
  const schema = {
    days: "number",
    generation: "number",
    radiation: "number",
    bess_export: "number",
    bess_import: "number",
    plant_availability: "number",
    bess_availability: "number",
    grid_availability: "number",
    peak_power: "number",
    cumulative_generation: "number",
    cumulative_bess_export: "number",
    cumulative_bess_import: "number",
    daily_cuf_worc: "number",
    cuf_till_date: "number",
  };

  const errors = [];

  for (const field in schema) {
    const val = row[field];
    if (val === null || val === undefined || val === "") continue;

    if (schema[field] === "number" && isNaN(Number(val))) {
      errors.push({
        field,
        value: val,
        type: typeof val,
        expected: "number",
      });
    }
  }

  return errors;
};

const uploadOMSolarBessFromExcel = async (req, res) => {
  try {
    console.log("Solar+BESS, Upload from excel called");

    const { dept_id, statistic_id, entity_id } = req.query;

    if (!dept_id || !statistic_id || !entity_id) {
      return res.status(400).json({
        message: "dept_id, statistic_id and entity_id are required",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        message: "Excel file is required",
      });
    }

    /* ---------- Read Excel ---------- */
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];

    const rows = XLSX.utils.sheet_to_json(sheet, {
      raw: false,
      defval: null,
    });

    if (!rows.length) {
      return res.status(400).json({ message: "Excel file is empty" });
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    /* ---------- Process Rows ---------- */
    for (const row of rows) {
      try {
        const typeErrors = validateSolarBessRowTypes(row);
        if (typeErrors.length) {
          console.error("❌ Datatype mismatch:", typeErrors);
          skipped++;
          continue;
        }

        const normalizedDate = normalizeDate(row.date);
        if (!normalizedDate) {
          skipped++;
          continue;
        }

        const payload = {
          dept_id,
          statistic_id,
          entity_id,
          date: normalizedDate,
          days: row.days,
          generation: row.generation,
          radiation: row.radiation,
          bess_export: row.bess_export,
          bess_import: row.bess_import,
          plant_availability: row.plant_availability,
          bess_availability: row.bess_availability,
          grid_availability: row.grid_availability,
          peak_power: row.peak_power,
          cumulative_generation: row.cumulative_generation,
          cumulative_bess_export: row.cumulative_bess_export,
          cumulative_bess_import: row.cumulative_bess_import,
          daily_cuf_worc: row.daily_cuf_worc,
          cuf_till_date: row.cuf_till_date,
          remarks: row.remarks || null,
          is_active: row.is_active ?? 1,
        };

        const existingRecord = await OMDGRSolarBESS.findOne({
          where: {
            dept_id,
            statistic_id,
            entity_id,
            date: normalizedDate,
          },
        });

        /* -------- ADD -------- */
        if (!existingRecord) {
          await OMDGRSolarBESS.create(payload);
          inserted++;
        } else {
          /* -------- UPDATE -------- */
          await existingRecord.update(payload);
          updated++;
        }
      } catch (rowError) {
        console.error("❌ Row failed:", row, rowError.message);
        skipped++;
      }
    }

    return res.status(200).json({
      message: "OM DGR Solar + BESS Excel processed successfully",
      summary: {
        totalRows: rows.length,
        inserted,
        updated,
        skipped,
      },
    });
  } catch (error) {
    console.error("Excel Upload Error:", error);
    return res.status(500).json({
      message: "Internal Server Error",
      error: error.message,
    });
  }
};

const express = require("express");
const { json } = require("sequelize");
const { isNumber, normalizeDate } = require("../utils/helper");
const router = express.Router();
router.use(requireDeptEditAccess);
router.post("/", verifyToken, upload.single("doc_file"), addDocument);

router.post("/add", verifyToken, upload.single("doc_file"), addCorrespondence);

router.post("/new", verifyToken, upload.single("doc_file"), addIssue);

// REIA document
router.post(
  "/update",
  verifyToken,
  upload.single("doc_file"),
  updateREIADocument
);

// Upload O&M file using excel mode
router.post(
  "/one/:dept_id/:statistic_id/:entity_id",
  verifyToken,
  upload.single("doc_file"),
  addOMEntriesByExcel
);

router.post(
  "/solar_bess",
  verifyToken,
  upload.single("excelFile"),
  uploadOMSolarBessFromExcel
);

router.post(
  "/solar",
  verifyToken,
  upload.single("excelFile"),
  uploadOMSolarFromExcel
);

// PMC C&E upload endpoints (under whichever base this router is mounted)
router.post(
  "/pmc_ce/document",
  verifyToken,
  upload.single("doc_file"),
  addPmcCeDocumentUpload,
);

router.post(
  "/pmc_ce/correspondence",
  verifyToken,
  upload.single("doc_file"),
  addPmcCeCorrespondenceUpload,
);

// ---- Tariff Petition upload endpoint ----
const addTariffDocument = async (req, res) => {
  try {
    console.log('addTariffDocument called');
    console.log('body:', req.body);
    console.log('file:', req.file ? { originalname: req.file.originalname, path: req.file.path } : null);

    const { dept_id, statistic_id, entity_id, document_name, doc_date } = req.body;
    const filePath = req.file ? req.file.path : null;

    const bad = (v) => !v || v === 'null' || v === 'undefined';
    if (bad(dept_id) || bad(statistic_id) || bad(entity_id)) return res.status(400).json({ error: 'Missing dept_id/statistic_id/entity_id' });

    const name = document_name && document_name !== 'null' ? document_name : (req.file ? req.file.originalname : 'Tariff Petition');

    const created = await TariffPetition.create({
      dept_id,
      statistic_id,
      entity_id,
      document_name: name,
      storage_path: filePath,
      original_name: req.file ? req.file.originalname : null,
      mime_type: req.file ? req.file.mimetype : null,
      size: req.file ? req.file.size : null,
      doc_date: doc_date || null,
    });

    return res.status(201).json(created);
  } catch (err) {
    console.error('addTariffDocument error:', err);
    return res.status(500).json({ error: 'Failed to add tariff petition', detail: err.message });
  }
};

router.post('/tariff/document', verifyToken, upload.single('doc_file'), addTariffDocument);

// ---- PMC BMS upload endpoints ----

const addBmsDocument = async (req, res) => {
  try {
    const { doc_name, doc_date } = req.body;
    let entity_id = req.body.entity_id || req.body.pmc_entry_id || null;
    const project_name = req.body.project_name || null;
    const sliceContext = buildBmsSliceContext(project_name);
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;
    if (!filePath) return res.status(400).json({ error: "No file uploaded" });
    // Prefer UUID linkage when project resolves uniquely; otherwise keep project-wise
    // association via deterministic BMS slice context before milestone creation.
    if (!entity_id && project_name) {
      entity_id = await resolvePmcEntryIdByProjectName(project_name);
      if (!entity_id && sliceContext) entity_id = sliceContext;
    }

    if (!entity_id || (!isUuid(entity_id) && !isBmsSliceContext(entity_id))) {
      return res.status(400).json({ error: 'Missing project context. Provide pmc_entry_id UUID or valid project_name.' });
    }

    const doc = await BmsContractDocument.create({
      pmc_entry_id: entity_id || null,
      file_name: req.file.filename,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
      storage_path: filePath,
      description: doc_name || path.basename(req.file.originalname, path.extname(req.file.originalname)),
      doc_date: doc_date || null,
    });
    // Return created doc plus the project_name that was used/resolved (if any)
    const out = doc.toJSON ? doc.toJSON() : doc;
    out.project_name = project_name || null;
    res.json(out);
  } catch (err) {
    console.error("addBmsDocument error:", err);
    res.status(500).json({ error: "Failed to add BMS document", detail: err.message });
  }
};

const addBmsCorrespondence = async (req, res) => {
  try {
    const { subject, from, to, correspondence_date } = req.body;
    let entity_id = req.body.entity_id || req.body.pmc_entry_id || null;
    const project_name = req.body.project_name || null;
    const sliceContext = buildBmsSliceContext(project_name);
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;
    // Prefer UUID linkage when resolvable; otherwise persist against BMS slice context.
    if (!entity_id && project_name) {
      entity_id = await resolvePmcEntryIdByProjectName(project_name);
      if (!entity_id && sliceContext) entity_id = sliceContext;
    }

    if (!entity_id || (!isUuid(entity_id) && !isBmsSliceContext(entity_id))) {
      return res.status(400).json({ error: 'Missing project context. Provide pmc_entry_id UUID or valid project_name.' });
    }

    const corr = await BmsCorrespondenceOther.create({
      pmc_entry_id: entity_id || null,
      subject: subject,
      correspondent: from ? `${from} -> ${to}` : null,
      sender: from || null,
      recipient: to || null,
      correspondence_date: correspondence_date || null,
      file_name: req.file ? req.file.filename : null,
      original_name: req.file ? req.file.originalname : null,
      mime_type: req.file ? req.file.mimetype : null,
      size: req.file ? req.file.size : null,
      storage_path: filePath,
    });
    res.json(corr);
  } catch (err) {
    console.error("addBmsCorrespondence error:", err);
    res.status(500).json({ error: "Failed to add BMS correspondence", detail: err.message });
  }
};

router.post(
  "/bms/document",
  verifyToken,
  upload.single("doc_file"),
  addBmsDocument,
);

router.post(
  "/bms/correspondence",
  verifyToken,
  upload.single("doc_file"),
  addBmsCorrespondence,
);

// ---- PMC BMS GET endpoints ----
router.get("/bms/documents", verifyToken, async (req, res) => {
  try {
    let entityId = req.query.entity_id || req.query.pmc_entry_id || null;
    const project_name = req.query.project_name || null;
    const sliceContext = buildBmsSliceContext(project_name);
    const where = {};

    if (!entityId && project_name) {
      entityId = await resolvePmcEntryIdByProjectName(project_name);
      if (!entityId && sliceContext) entityId = sliceContext;
    }

    if (!entityId) {
      // No project context provided — do not return all documents. Return empty list.
      return res.json([]);
    }

    if (!isUuid(entityId) && !isBmsSliceContext(entityId)) return res.json([]);

    if (isUuid(entityId) && sliceContext) {
      where[Op.or] = [{ pmc_entry_id: entityId }, { pmc_entry_id: sliceContext }];
    } else {
      where.pmc_entry_id = entityId;
    }
    const docs = await BmsContractDocument.findAll({ where, order: [["created_at", "DESC"]] });
    const out = docs.map((doc) => {
      const row = doc.toJSON ? doc.toJSON() : doc;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET bms/documents error:", err);
    res.status(500).json({ error: "Failed to fetch BMS documents" });
  }
});

router.get("/bms/correspondences", verifyToken, async (req, res) => {
  try {
    let entityId = req.query.entity_id || req.query.pmc_entry_id || null;
    const project_name = req.query.project_name || null;
    const sliceContext = buildBmsSliceContext(project_name);
    const where = {};

    if (!entityId && project_name) {
      entityId = await resolvePmcEntryIdByProjectName(project_name);
      if (!entityId && sliceContext) entityId = sliceContext;
    }

    if (!entityId || (!isUuid(entityId) && !isBmsSliceContext(entityId))) return res.json([]);

    if (isUuid(entityId) && sliceContext) {
      where[Op.or] = [{ pmc_entry_id: entityId }, { pmc_entry_id: sliceContext }];
    } else {
      where.pmc_entry_id = entityId;
    }
    const items = await BmsCorrespondenceOther.findAll({ where, order: [["created_at", "DESC"]] });
    const out = items.map((item) => {
      const row = item.toJSON ? item.toJSON() : item;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET bms/correspondences error:", err);
    res.status(500).json({ error: "Failed to fetch BMS correspondences" });
  }
});

router.delete("/bms/document/:id", verifyToken, async (req, res) => {
  try {
    const doc = await BmsContractDocument.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await doc.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE bms/document error:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

router.put("/bms/document/:id", verifyToken, upload.single("doc_file"), async (req, res) => {
  try {
    const doc = await BmsContractDocument.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const { doc_name, doc_date, entity_id } = req.body || {};
    if (entity_id) doc.pmc_entry_id = entity_id;
    if (doc_name != null) doc.description = doc_name;
    if (doc_date != null) doc.doc_date = doc_date || null;

    if (req.file) {
      doc.file_name = req.file.filename;
      doc.original_name = req.file.originalname;
      doc.mime_type = req.file.mimetype;
      doc.size = req.file.size;
      doc.storage_path = toPublicUploadPath(req.file.path);
    }

    await doc.save();
    res.json(doc);
  } catch (err) {
    console.error("PUT bms/document error:", err);
    res.status(500).json({ error: "Failed to update document", detail: err.message });
  }
});

router.delete("/bms/correspondence/:id", verifyToken, async (req, res) => {
  try {
    const corr = await BmsCorrespondenceOther.findByPk(req.params.id);
    if (!corr) return res.status(404).json({ error: "Correspondence not found" });
    await corr.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE bms/correspondence error:", err);
    res.status(500).json({ error: "Failed to delete correspondence" });
  }
});

router.put("/bms/correspondence/:id", verifyToken, upload.single("doc_file"), async (req, res) => {
  try {
    const corr = await BmsCorrespondenceOther.findByPk(req.params.id);
    if (!corr) return res.status(404).json({ error: "Correspondence not found" });

    const { subject, from, to, correspondence_date, entity_id } = req.body || {};
    if (entity_id) corr.pmc_entry_id = entity_id;
    if (subject != null) corr.subject = subject;
    if (from != null) corr.sender = from || null;
    if (to != null) corr.recipient = to || null;
    if (from != null || to != null) corr.correspondent = (from || to) ? `${from || ''} -> ${to || ''}` : null;
    if (correspondence_date != null) corr.correspondence_date = correspondence_date || null;

    if (req.file) {
      corr.file_name = req.file.filename;
      corr.original_name = req.file.originalname;
      corr.mime_type = req.file.mimetype;
      corr.size = req.file.size;
      corr.storage_path = toPublicUploadPath(req.file.path);
    }

    await corr.save();
    res.json(corr);
  } catch (err) {
    console.error("PUT bms/correspondence error:", err);
    res.status(500).json({ error: "Failed to update correspondence", detail: err.message });
  }
});

// ---- PMC DPR/PFR upload endpoints ----

const addDprDocument = async (req, res) => {
  try {
    const { doc_name, doc_date, project_name } = req.body;
    let entity_id = req.body.entity_id || req.body.pmc_entry_id || null;
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;
    if (!filePath) return res.status(400).json({ error: "No file uploaded" });

    if (!entity_id && project_name) {
      const ids = await resolvePmcEntryIdsByProjectName(project_name);
      if (ids.length) entity_id = ids[0];
      if (!entity_id) entity_id = buildDprSliceContext(project_name);
    }

    if (entity_id && isDprSliceContext(entity_id) && project_name) {
      const ids = await resolvePmcEntryIdsByProjectName(project_name);
      if (ids.length) entity_id = ids[0];
    }

    const doc = await DprContractDocument.create({
      pmc_entry_id: entity_id || null,
      file_name: req.file.filename,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
      storage_path: filePath,
      description: doc_name || path.basename(req.file.originalname, path.extname(req.file.originalname)),
      doc_date: doc_date || null,
    });
    res.json(doc);
  } catch (err) {
    console.error("addDprDocument error:", err);
    res.status(500).json({ error: "Failed to add DPR document", detail: err.message });
  }
};

const addDprCorrespondence = async (req, res) => {
  try {
    const { subject, from, to, correspondence_date, project_name } = req.body;
    let entity_id = req.body.entity_id || req.body.pmc_entry_id || null;
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;

    if (!entity_id && project_name) {
      const ids = await resolvePmcEntryIdsByProjectName(project_name);
      if (ids.length) entity_id = ids[0];
      if (!entity_id) entity_id = buildDprSliceContext(project_name);
    }

    if (entity_id && isDprSliceContext(entity_id) && project_name) {
      const ids = await resolvePmcEntryIdsByProjectName(project_name);
      if (ids.length) entity_id = ids[0];
    }

    const corr = await DprCorrespondenceOther.create({
      pmc_entry_id: entity_id || null,
      subject: subject,
      correspondent: from ? `${from} -> ${to}` : null,
      sender: from || null,
      recipient: to || null,
      correspondence_date: correspondence_date || null,
      file_name: req.file ? req.file.filename : null,
      original_name: req.file ? req.file.originalname : null,
      mime_type: req.file ? req.file.mimetype : null,
      size: req.file ? req.file.size : null,
      storage_path: filePath,
    });
    res.json(corr);
  } catch (err) {
    console.error("addDprCorrespondence error:", err);
    res.status(500).json({ error: "Failed to add DPR correspondence", detail: err.message });
  }
};

// ---- PMC Execution Document handlers ----
const addExecutionDocument = async (req, res) => {
  try {
    const { doc_name, doc_date } = req.body;
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;
    if (!filePath) return res.status(400).json({ error: "No file uploaded" });

    let pmc_entry_id = await resolveExecutionEntityId(req.body || {});

    if (!pmc_entry_id || pmc_entry_id === 'null') {
      console.error('addExecutionDocument: missing pmc_entry_id', { body: req.body });
      return res.status(400).json({ error: 'Missing pmc_entry_id (pmc entry identifier) for execution document' });
    }

    const doc = await PmcExecutionDocument.create({
      pmc_entry_id: pmc_entry_id,
      file_name: req.file.filename,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
      storage_path: filePath,
      description: doc_name || path.basename(req.file.originalname, path.extname(req.file.originalname)),
      doc_date: doc_date || null,
      doc_type: 'contract',
    });
    res.json(doc);
  } catch (err) {
    console.error("addExecutionDocument error:", err);
    res.status(500).json({ error: "Failed to add execution document", detail: err.message });
  }
};

const addExecutionDpr = async (req, res) => {
  try {
    const { doc_name, doc_date } = req.body;
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;
    if (!filePath) return res.status(400).json({ error: "No file uploaded" });

    let pmc_entry_id = await resolveExecutionEntityId(req.body || {});

    if (!pmc_entry_id || pmc_entry_id === 'null') {
      console.error('addExecutionDpr: missing pmc_entry_id', { body: req.body });
      return res.status(400).json({ error: 'Missing pmc_entry_id (pmc entry identifier) for DPR' });
    }

    const doc = await PmcExecutionDocument.create({
      pmc_entry_id: pmc_entry_id,
      file_name: req.file.filename,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
      storage_path: filePath,
      description: doc_name || path.basename(req.file.originalname, path.extname(req.file.originalname)),
      doc_date: doc_date || null,
      doc_type: 'dpr',
    });
    res.json(doc);
  } catch (err) {
    console.error("addExecutionDpr error:", err);
    res.status(500).json({ error: "Failed to add DPR", detail: err.message });
  }
};

const addExecutionMpr = async (req, res) => {
  try {
    const { doc_name, doc_date } = req.body;
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;
    if (!filePath) return res.status(400).json({ error: "No file uploaded" });

    let pmc_entry_id = await resolveExecutionEntityId(req.body || {});

    if (!pmc_entry_id || pmc_entry_id === 'null') {
      console.error('addExecutionMpr: missing pmc_entry_id', { body: req.body });
      return res.status(400).json({ error: 'Missing pmc_entry_id (pmc entry identifier) for MPR' });
    }

    const doc = await PmcExecutionDocument.create({
      pmc_entry_id: pmc_entry_id,
      file_name: req.file.filename,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
      storage_path: filePath,
      description: doc_name || path.basename(req.file.originalname, path.extname(req.file.originalname)),
      doc_date: doc_date || null,
      doc_type: 'mpr',
    });
    res.json(doc);
  } catch (err) {
    console.error("addExecutionMpr error:", err);
    res.status(500).json({ error: "Failed to add MPR", detail: err.message });
  }
};

const addExecutionCorrespondence = async (req, res) => {
  try {
    const { subject, from, to, correspondence_date, correspondence_type } = req.body;
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;

    let pmc_entry_id = await resolveExecutionEntityId(req.body || {});

    if (!pmc_entry_id || pmc_entry_id === 'null') {
      console.error('addExecutionCorrespondence: missing pmc_entry_id', { body: req.body });
      return res.status(400).json({ error: 'Missing pmc_entry_id (pmc entry identifier) for execution correspondence' });
    }

    const corr = await PmcExecutionCorrespondence.create({
      pmc_entry_id: pmc_entry_id,
      subject: subject || null,
      sender: from || null,
      recipient: to || null,
      correspondence_date: correspondence_date || null,
      correspondence_type: correspondence_type || 'contractor',
      file_name: req.file ? req.file.filename : null,
      original_name: req.file ? req.file.originalname : null,
      mime_type: req.file ? req.file.mimetype : null,
      size: req.file ? req.file.size : null,
      storage_path: filePath,
    });

    res.status(201).json(corr);
  } catch (err) {
    console.error("addExecutionCorrespondence error:", err);
    res.status(500).json({ error: "Failed to add correspondence", detail: err.message });
  }
};

const addExecutionIssue = async (req, res) => {
  try {
    const { issue_description, issue_pertaining_to, issue_date } = req.body;
    const filePath = req.file ? toPublicUploadPath(req.file.path) : null;

    let pmc_entry_id = await resolveExecutionEntityId(req.body || {});

    if (!pmc_entry_id || pmc_entry_id === 'null') {
      console.error('addExecutionIssue: missing pmc_entry_id', { body: req.body });
      return res.status(400).json({ error: 'Missing pmc_entry_id (pmc entry identifier) for execution issue' });
    }

    const issue = await PmcExecutionIssue.create({
      pmc_entry_id: pmc_entry_id,
      issue_description: issue_description || null,
      issue_pertaining_to: issue_pertaining_to || null,
      issue_date: issue_date || null,
      file_name: req.file ? req.file.filename : null,
      original_name: req.file ? req.file.originalname : null,
      mime_type: req.file ? req.file.mimetype : null,
      size: req.file ? req.file.size : null,
      storage_path: filePath,
    });
    res.status(201).json(issue);
  } catch (err) {
    console.error("addExecutionIssue error:", err);
    res.status(500).json({ error: "Failed to add issue", detail: err.message });
  }
};

router.post(
  "/dpr/document",
  verifyToken,
  upload.single("doc_file"),
  addDprDocument,
);

router.post(
  "/dpr/correspondence",
  verifyToken,
  upload.single("doc_file"),
  addDprCorrespondence,
);

// ---- PMC DPR/PFR GET endpoints ----
router.get("/dpr/documents", verifyToken, async (req, res) => {
  try {
    const context = await resolveDprContext(req.query || {});
    const where = {};
    const matchIds = Array.from(new Set([].concat(context.ids || [], context.rawEntity ? [context.rawEntity] : [], context.dprSliceContext ? [context.dprSliceContext] : []))).filter(Boolean);
    if (matchIds.length) where.pmc_entry_id = { [Op.in]: matchIds };
    else return res.json([]);
    const docs = await DprContractDocument.findAll({ where, order: [["created_at", "DESC"]] });
    const out = docs.map((doc) => {
      const row = doc.toJSON ? doc.toJSON() : doc;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET dpr/documents error:", err);
    res.status(500).json({ error: "Failed to fetch DPR documents" });
  }
});

router.get("/dpr/correspondences", verifyToken, async (req, res) => {
  try {
    const context = await resolveDprContext(req.query || {});
    const where = {};
    const matchIds = Array.from(new Set([].concat(context.ids || [], context.rawEntity ? [context.rawEntity] : [], context.dprSliceContext ? [context.dprSliceContext] : []))).filter(Boolean);
    if (matchIds.length) where.pmc_entry_id = { [Op.in]: matchIds };
    else return res.json([]);
    const items = await DprCorrespondenceOther.findAll({ where, order: [["created_at", "DESC"]] });
    const out = items.map((item) => {
      const row = item.toJSON ? item.toJSON() : item;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET dpr/correspondences error:", err);
    res.status(500).json({ error: "Failed to fetch DPR correspondences" });
  }
});

router.delete("/dpr/document/:id", verifyToken, async (req, res) => {
  try {
    const doc = await DprContractDocument.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await doc.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE dpr/document error:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

router.put("/dpr/document/:id", verifyToken, upload.single("doc_file"), async (req, res) => {
  try {
    const doc = await DprContractDocument.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const { doc_name, doc_date, entity_id } = req.body || {};
    if (entity_id) doc.pmc_entry_id = entity_id;
    if (doc_name != null) doc.description = doc_name;
    if (doc_date != null) doc.doc_date = doc_date || null;

    if (req.file) {
      doc.file_name = req.file.filename;
      doc.original_name = req.file.originalname;
      doc.mime_type = req.file.mimetype;
      doc.size = req.file.size;
      doc.storage_path = toPublicUploadPath(req.file.path);
    }

    await doc.save();
    res.json(doc);
  } catch (err) {
    console.error("PUT dpr/document error:", err);
    res.status(500).json({ error: "Failed to update document", detail: err.message });
  }
});

router.delete("/dpr/correspondence/:id", verifyToken, async (req, res) => {
  try {
    const corr = await DprCorrespondenceOther.findByPk(req.params.id);
    if (!corr) return res.status(404).json({ error: "Correspondence not found" });
    await corr.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE dpr/correspondence error:", err);
    res.status(500).json({ error: "Failed to delete correspondence" });
  }
});

router.put("/dpr/correspondence/:id", verifyToken, upload.single("doc_file"), async (req, res) => {
  try {
    const corr = await DprCorrespondenceOther.findByPk(req.params.id);
    if (!corr) return res.status(404).json({ error: "Correspondence not found" });

    const { subject, from, to, correspondence_date, entity_id } = req.body || {};
    if (entity_id) corr.pmc_entry_id = entity_id;
    if (subject != null) corr.subject = subject;
    if (from != null) corr.sender = from || null;
    if (to != null) corr.recipient = to || null;
    if (from != null || to != null) corr.correspondent = (from || to) ? `${from || ''} -> ${to || ''}` : null;
    if (correspondence_date != null) corr.correspondence_date = correspondence_date || null;

    if (req.file) {
      corr.file_name = req.file.filename;
      corr.original_name = req.file.originalname;
      corr.mime_type = req.file.mimetype;
      corr.size = req.file.size;
      corr.storage_path = toPublicUploadPath(req.file.path);
    }

    await corr.save();
    res.json(corr);
  } catch (err) {
    console.error("PUT dpr/correspondence error:", err);
    res.status(500).json({ error: "Failed to update correspondence", detail: err.message });
  }
});

// ---- PMC Execution Document POST endpoints ----
router.post(
  "/execution/document",
  verifyToken,
  upload.single("doc_file"),
  addExecutionDocument,
);

router.post(
  "/execution/dpr",
  verifyToken,
  upload.single("doc_file"),
  addExecutionDpr,
);

router.post(
  "/execution/mpr",
  verifyToken,
  upload.single("doc_file"),
  addExecutionMpr,
);

router.post(
  "/execution/correspondences",
  verifyToken,
  upload.single("doc_file"),
  addExecutionCorrespondence,
);

router.post(
  "/execution/issues",
  verifyToken,
  upload.single("doc_file"),
  addExecutionIssue,
);

// --- DPR issues (separate table) ---
router.post(
  "/dpr/issues",
  verifyToken,
  upload.single("doc_file"),
  async (req, res) => {
    try {
      let { pmc_entry_id, pmc_slice_context, issue_description, issue_pertaining_to, issue_date } = req.body;
      const project_name = req.body.project_name || '';
      if (!pmc_slice_context && project_name) pmc_slice_context = buildDprSliceContext(project_name);
      if (pmc_slice_context && !isDprSliceContext(pmc_slice_context)) {
        pmc_slice_context = buildDprSliceContext(pmc_slice_context) || pmc_slice_context;
      }
      if (!pmc_entry_id && project_name) {
        const ids = await resolvePmcEntryIdsByProjectName(project_name);
        if (ids.length) pmc_entry_id = ids[0];
      }
      if (pmc_entry_id && isDprSliceContext(pmc_entry_id)) {
        if (!pmc_slice_context) pmc_slice_context = pmc_entry_id;
        pmc_entry_id = null;
      }
      const filePath = req.file ? toPublicUploadPath(req.file.path) : null;
      const issue = await PmcDprIssue.create({
        pmc_entry_id: pmc_entry_id || null,
        pmc_slice_context: pmc_slice_context || null,
        issue_description: issue_description || null,
        issue_pertaining_to: issue_pertaining_to || null,
        issue_date: issue_date || null,
        file_name: req.file ? req.file.filename : null,
        original_name: req.file ? req.file.originalname : null,
        mime_type: req.file ? req.file.mimetype : null,
        size: req.file ? req.file.size : null,
        storage_path: filePath,
      });
      res.status(201).json(issue);
    } catch (err) {
      console.error('add DPR issue error:', err);
      res.status(500).json({ error: 'Failed to add DPR issue', detail: err.message });
    }
  }
);

// DPR GET
router.get('/dpr/issues', verifyToken, async (req, res) => {
  try {
    const entityId = req.query.entity_id || req.query.pmc_entry_id || req.query.pmc_dpr_entity_id || null;
    const context = await resolveDprContext({
      entity_id: entityId,
      pmc_entry_id: entityId,
      project_name: req.query.project_name || '',
    });
    const where = {};
    const matchIds = Array.from(new Set([].concat(context.ids || [], context.rawEntity ? [context.rawEntity] : []))).filter(Boolean);
    if (matchIds.length && context.dprSliceContext) {
      where[Op.or] = [
        { pmc_entry_id: { [Op.in]: matchIds } },
        { pmc_slice_context: context.dprSliceContext },
      ];
    } else if (matchIds.length) {
      where.pmc_entry_id = { [Op.in]: matchIds };
    } else if (context.dprSliceContext) {
      where.pmc_slice_context = context.dprSliceContext;
    } else {
      return res.json([]);
    }
    const items = await PmcDprIssue.findAll({ where, order: [['createdAt','DESC']] });
    const out = items.map((item) => {
      const row = item.toJSON ? item.toJSON() : item;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error('GET dpr/issues error:', err);
    res.status(500).json({ error: 'Failed to fetch DPR issues' });
  }
});

// DPR UPDATE
router.put('/dpr/issue/:id', verifyToken, upload.single('doc_file'), async (req, res) => {
  try {
    const it = await PmcDprIssue.findByPk(req.params.id);
    if (!it) return res.status(404).json({ error: 'Issue not found' });

    const { issue_description, issue_pertaining_to, issue_date } = req.body || {};
    it.issue_description = issue_description != null ? issue_description : it.issue_description;
    it.issue_pertaining_to = issue_pertaining_to != null ? issue_pertaining_to : it.issue_pertaining_to;
    it.issue_date = issue_date != null ? issue_date : it.issue_date;

    if (req.file) {
      it.file_name = req.file.filename;
      it.original_name = req.file.originalname;
      it.mime_type = req.file.mimetype;
      it.size = req.file.size;
      it.storage_path = toPublicUploadPath(req.file.path);
    }

    await it.save();
    res.json(it);
  } catch (err) {
    console.error('PUT dpr/issue error:', err);
    res.status(500).json({ error: 'Failed to update DPR issue', detail: err.message });
  }
});

// DPR DELETE
router.delete('/dpr/issue/:id', verifyToken, async (req, res) => {
  try {
    const it = await PmcDprIssue.findByPk(req.params.id);
    if (!it) return res.status(404).json({ error: 'Issue not found' });
    await it.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE dpr/issue error:', err);
    res.status(500).json({ error: 'Failed to delete DPR issue' });
  }
});

// --- BMS issues (separate table) ---
router.post(
  "/bms/issues",
  verifyToken,
  upload.single("doc_file"),
  async (req, res) => {
    try {
      let { pmc_entry_id, pmc_slice_context, issue_description, issue_pertaining_to, issue_date } = req.body;
      const project_name = req.body.project_name || null;
      const sliceContext = buildBmsSliceContext(project_name);
      if (!pmc_slice_context && sliceContext) pmc_slice_context = sliceContext;
      if (pmc_slice_context && !isBmsSliceContext(pmc_slice_context)) {
        pmc_slice_context = buildBmsSliceContext(pmc_slice_context) || pmc_slice_context;
      }

      // Prefer UUID when available; allow pmc_slice_context-only before milestone creation.
      if (!pmc_entry_id && project_name) {
        pmc_entry_id = await resolvePmcEntryIdByProjectName(project_name);
      }

      if (pmc_entry_id && isBmsSliceContext(pmc_entry_id)) {
        if (!pmc_slice_context) pmc_slice_context = pmc_entry_id;
        pmc_entry_id = null;
      }

      if (pmc_entry_id && !isUuid(pmc_entry_id)) {
        return res.status(400).json({ error: 'Invalid pmc_entry_id for BMS issue.' });
      }

      if (!pmc_entry_id && !pmc_slice_context) {
        return res.status(400).json({ error: 'Missing project context. Provide pmc_entry_id UUID or project_name.' });
      }

      const filePath = req.file ? toPublicUploadPath(req.file.path) : null;
      const issue = await PmcBmsIssue.create({
        pmc_entry_id: pmc_entry_id || null,
        pmc_slice_context: pmc_slice_context || null,
        issue_description: issue_description || null,
        issue_pertaining_to: issue_pertaining_to || null,
        issue_date: issue_date || null,
        file_name: req.file ? req.file.filename : null,
        original_name: req.file ? req.file.originalname : null,
        mime_type: req.file ? req.file.mimetype : null,
        size: req.file ? req.file.size : null,
        storage_path: filePath,
      });
      res.status(201).json(issue);
    } catch (err) {
      console.error('add BMS issue error:', err);
      res.status(500).json({ error: 'Failed to add BMS issue', detail: err.message });
    }
  }
);

// BMS GET
router.get('/bms/issues', verifyToken, async (req, res) => {
  try {
    let entityId = req.query.entity_id || req.query.pmc_entry_id || req.query.pmc_bms_entity_id || null;
    const project_name = req.query.project_name || null;
    const sliceContext = buildBmsSliceContext(project_name);
    const where = {};

    if (!entityId && project_name) {
      entityId = await resolvePmcEntryIdByProjectName(project_name);
      if (!entityId && sliceContext) entityId = sliceContext;
    }

    if (!entityId) return res.json([]);

    if (!isUuid(entityId) && !isBmsSliceContext(entityId)) {
      return res.json([]);
    }

    if (isUuid(entityId) && sliceContext) {
      where[Op.or] = [{ pmc_entry_id: entityId }, { pmc_slice_context: sliceContext }];
    } else if (isUuid(entityId)) {
      where.pmc_entry_id = entityId;
    } else {
      where.pmc_slice_context = entityId;
    }

    const items = await PmcBmsIssue.findAll({ where, order: [['createdAt','DESC']] });
    const out = items.map((item) => {
      const row = item.toJSON ? item.toJSON() : item;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error('GET bms/issues error:', err);
    res.status(500).json({ error: 'Failed to fetch BMS issues' });
  }
});

// BMS DELETE
router.delete('/bms/issue/:id', verifyToken, async (req, res) => {
  try {
    const it = await PmcBmsIssue.findByPk(req.params.id);
    if (!it) return res.status(404).json({ error: 'Issue not found' });
    await it.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE bms/issue error:', err);
    res.status(500).json({ error: 'Failed to delete BMS issue' });
  }
});

// BMS UPDATE
router.put('/bms/issue/:id', verifyToken, upload.single('doc_file'), async (req, res) => {
  try {
    const it = await PmcBmsIssue.findByPk(req.params.id);
    if (!it) return res.status(404).json({ error: 'Issue not found' });

    const { issue_description, issue_pertaining_to, issue_date } = req.body || {};
    it.issue_description = issue_description != null ? issue_description : it.issue_description;
    it.issue_pertaining_to = issue_pertaining_to != null ? issue_pertaining_to : it.issue_pertaining_to;
    it.issue_date = issue_date != null ? issue_date : it.issue_date;

    if (req.file) {
      it.file_name = req.file.filename;
      it.original_name = req.file.originalname;
      it.mime_type = req.file.mimetype;
      it.size = req.file.size;
      it.storage_path = toPublicUploadPath(req.file.path);
    }

    await it.save();
    res.json(it);
  } catch (err) {
    console.error('PUT bms/issue error:', err);
    res.status(500).json({ error: 'Failed to update BMS issue', detail: err.message });
  }
});

// ---- PMC Execution GET endpoints ----
router.get("/execution/documents", verifyToken, async (req, res) => {
  try {
    const entityIds = await resolveExecutionEntityIdsForQuery(req.query || {});
    const where = { doc_type: 'contract' };
    if (entityIds.length === 1) where.pmc_entry_id = entityIds[0];
    if (entityIds.length > 1) where.pmc_entry_id = { [Op.in]: entityIds };
    const docs = await PmcExecutionDocument.findAll({ where, order: [["createdAt", "DESC"]] });
    const out = docs.map((doc) => {
      const row = doc.toJSON ? doc.toJSON() : doc;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET execution/documents error:", err);
    res.status(500).json({ error: "Failed to fetch execution documents" });
  }
});

router.get("/execution/dpr", verifyToken, async (req, res) => {
  try {
    const entityIds = await resolveExecutionEntityIdsForQuery(req.query || {});
    const where = { doc_type: 'dpr' };
    if (entityIds.length === 1) where.pmc_entry_id = entityIds[0];
    if (entityIds.length > 1) where.pmc_entry_id = { [Op.in]: entityIds };
    const docs = await PmcExecutionDocument.findAll({ where, order: [["createdAt", "DESC"]] });
    const out = docs.map((doc) => {
      const row = doc.toJSON ? doc.toJSON() : doc;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET execution/dpr error:", err);
    res.status(500).json({ error: "Failed to fetch DPR documents" });
  }
});

router.get("/execution/mpr", verifyToken, async (req, res) => {
  try {
    const entityIds = await resolveExecutionEntityIdsForQuery(req.query || {});
    const where = { doc_type: 'mpr' };
    if (entityIds.length === 1) where.pmc_entry_id = entityIds[0];
    if (entityIds.length > 1) where.pmc_entry_id = { [Op.in]: entityIds };
    const docs = await PmcExecutionDocument.findAll({ where, order: [["createdAt", "DESC"]] });
    const out = docs.map((doc) => {
      const row = doc.toJSON ? doc.toJSON() : doc;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET execution/mpr error:", err);
    res.status(500).json({ error: "Failed to fetch MPR documents" });
  }
});

router.get("/execution/contractors", verifyToken, async (req, res) => {
  try {
    const entityIds = await resolveExecutionEntityIdsForQuery(req.query || {});
    const where = { correspondence_type: 'contractor' };
    if (entityIds.length === 1) where.pmc_entry_id = entityIds[0];
    if (entityIds.length > 1) where.pmc_entry_id = { [Op.in]: entityIds };
    const items = await PmcExecutionCorrespondence.findAll({ where, order: [["createdAt", "DESC"]] });
    const out = items.map((item) => {
      const row = item.toJSON ? item.toJSON() : item;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET execution/contractors error:", err);
    res.status(500).json({ error: "Failed to fetch contractor correspondences" });
  }
});

router.get("/execution/correspondence", verifyToken, async (req, res) => {
  try {
    const entityIds = await resolveExecutionEntityIdsForQuery(req.query || {});
    const where = { correspondence_type: 'stakeholder' };
    if (entityIds.length === 1) where.pmc_entry_id = entityIds[0];
    if (entityIds.length > 1) where.pmc_entry_id = { [Op.in]: entityIds };
    const items = await PmcExecutionCorrespondence.findAll({ where, order: [["createdAt", "DESC"]] });
    const out = items.map((item) => {
      const row = item.toJSON ? item.toJSON() : item;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET execution/correspondence error:", err);
    res.status(500).json({ error: "Failed to fetch correspondences" });
  }
});

router.get("/execution/issues", verifyToken, async (req, res) => {
  try {
    const entityIds = await resolveExecutionEntityIdsForQuery(req.query || {});
    const where = {};
    if (entityIds.length === 1) where.pmc_entry_id = entityIds[0];
    if (entityIds.length > 1) where.pmc_entry_id = { [Op.in]: entityIds };
    const issues = await PmcExecutionIssue.findAll({ where, order: [["createdAt", "DESC"]] });
    const out = issues.map((issue) => {
      const row = issue.toJSON ? issue.toJSON() : issue;
      row.storage_path = toPublicUploadPath(row.storage_path);
      return row;
    });
    res.json(out);
  } catch (err) {
    console.error("GET execution/issues error:", err);
    res.status(500).json({ error: "Failed to fetch issues" });
  }
});

// ---- PMC Execution DELETE endpoints ----
router.delete("/execution/document/:id", verifyToken, async (req, res) => {
  try {
    const doc = await PmcExecutionDocument.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await doc.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE execution/document error:", err);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

router.put("/execution/document/:id", verifyToken, upload.single("doc_file"), async (req, res) => {
  try {
    const doc = await PmcExecutionDocument.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    const { doc_name, doc_date, pmc_entry_id } = req.body || {};
    if (pmc_entry_id) doc.pmc_entry_id = pmc_entry_id;
    if (doc_name != null) doc.description = doc_name;
    if (doc_date != null) doc.doc_date = doc_date || null;

    if (req.file) {
      doc.file_name = req.file.filename;
      doc.original_name = req.file.originalname;
      doc.mime_type = req.file.mimetype;
      doc.size = req.file.size;
      doc.storage_path = toPublicUploadPath(req.file.path);
    }

    await doc.save();
    res.json(doc);
  } catch (err) {
    console.error("PUT execution/document error:", err);
    res.status(500).json({ error: "Failed to update document", detail: err.message });
  }
});

router.delete("/execution/dpr/:id", verifyToken, async (req, res) => {
  try {
    const doc = await PmcExecutionDocument.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await doc.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE execution/dpr error:", err);
    res.status(500).json({ error: "Failed to delete DPR" });
  }
});

router.delete("/execution/mpr/:id", verifyToken, async (req, res) => {
  try {
    const doc = await PmcExecutionDocument.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    await doc.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE execution/mpr error:", err);
    res.status(500).json({ error: "Failed to delete MPR" });
  }
});

router.delete("/execution/correspondence/:id", verifyToken, async (req, res) => {
  try {
    const corr = await PmcExecutionCorrespondence.findByPk(req.params.id);
    if (!corr) return res.status(404).json({ error: "Correspondence not found" });
    await corr.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE execution/correspondence error:", err);
    res.status(500).json({ error: "Failed to delete correspondence" });
  }
});

router.put("/execution/correspondence/:id", verifyToken, upload.single("doc_file"), async (req, res) => {
  try {
    const corr = await PmcExecutionCorrespondence.findByPk(req.params.id);
    if (!corr) return res.status(404).json({ error: "Correspondence not found" });

    const { subject, from, to, correspondence_date, pmc_entry_id } = req.body || {};
    if (pmc_entry_id) corr.pmc_entry_id = pmc_entry_id;
    if (subject != null) corr.subject = subject;
    if (from != null) corr.sender = from || null;
    if (to != null) corr.recipient = to || null;
    if (correspondence_date != null) corr.correspondence_date = correspondence_date || null;

    if (req.file) {
      corr.file_name = req.file.filename;
      corr.original_name = req.file.originalname;
      corr.mime_type = req.file.mimetype;
      corr.size = req.file.size;
      corr.storage_path = toPublicUploadPath(req.file.path);
    }

    await corr.save();
    res.json(corr);
  } catch (err) {
    console.error("PUT execution/correspondence error:", err);
    res.status(500).json({ error: "Failed to update correspondence", detail: err.message });
  }
});

router.delete("/execution/issue/:id", verifyToken, async (req, res) => {
  try {
    const issue = await PmcExecutionIssue.findByPk(req.params.id);
    if (!issue) return res.status(404).json({ error: "Issue not found" });
    await issue.destroy();
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE execution/issue error:", err);
    res.status(500).json({ error: "Failed to delete issue" });
  }
});

router.put("/execution/issue/:id", verifyToken, upload.single("doc_file"), async (req, res) => {
  try {
    const issue = await PmcExecutionIssue.findByPk(req.params.id);
    if (!issue) return res.status(404).json({ error: "Issue not found" });

    const { issue_description, issue_pertaining_to, issue_date, pmc_entry_id } = req.body || {};
    if (pmc_entry_id) issue.pmc_entry_id = pmc_entry_id;
    if (issue_description != null) issue.issue_description = issue_description;
    if (issue_pertaining_to != null) issue.issue_pertaining_to = issue_pertaining_to;
    if (issue_date != null) issue.issue_date = issue_date || null;

    if (req.file) {
      issue.file_name = req.file.filename;
      issue.original_name = req.file.originalname;
      issue.mime_type = req.file.mimetype;
      issue.size = req.file.size;
      issue.storage_path = toPublicUploadPath(req.file.path);
    }

    await issue.save();
    res.json(issue);
  } catch (err) {
    console.error("PUT execution/issue error:", err);
    res.status(500).json({ error: "Failed to update issue", detail: err.message });
  }
});

// Debug: list routes registered on this router
// ── QA MDCC Inspect file uploads (Excel / PDF) ──────────────
// Used by qa_external.html MDCC modal to attach Inspect evidence files.
router.post(
  "/qa/mdcc/inspect/upload",
  verifyToken,
  upload.single("inspect_file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ success: false, message: "No file uploaded" });
      }
      // Return the stored filename relative to the uploads dir; the /uploads static
      // route serves these files, so clients can build a download URL from this.
      return res.status(200).json({
        success: true,
        message: "File uploaded successfully",
        data: { filename: req.file.filename, original: req.file.originalname, url: `/uploads/${req.file.filename}` },
      });
    } catch (err) {
      console.error("qa mdcc inspect upload error:", err);
      return res.status(500).json({ success: false, message: "Failed to upload inspect file" });
    }
  }
);

router.get('/__debug_routes', (req, res) => {
  try {
    const routes = router.stack
      .filter((layer) => layer && layer.route)
      .map((layer) => ({ path: layer.route.path, methods: Object.keys(layer.route.methods).join(',') }));
    res.json({ routes });
  } catch (err) {
    console.error('debug routes error', err);
    res.status(500).json({ error: 'Failed to list routes' });
  }
});

module.exports = router;
