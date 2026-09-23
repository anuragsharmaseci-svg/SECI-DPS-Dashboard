/**
 * ==========================================
 * CENTRALIZED DATA CONTROLLERS
 * ==========================================
 * 
 * This file consolidates all data management and CRUD operations for the SECI DPS Dashboard.
 * It includes controllers for:
 *   - PMC (Project Management Consultancy) operations
 *   - Business Development (BD) tracking
 *   - Department and statistic management
 *   - User access control and permissions
 *   - Operations & Maintenance (O&M) data (Solar, Solar+BESS, DGR)
 *   - Entity documents, correspondences, issues, and milestones
 *   - Slice metadata (segment-specific data: DPR, BMS, Execution)
 *   - PMC Consultancy & Engineering milestones
 * 
 * ARCHITECTURE:
 *   - Uses Sequelize ORM for database interactions
 *   - Implements standard CRUD patterns (Create, Read, Update, Delete)
 *   - Handles data validation and normalization
 *   - Includes soft-delete logic (is_active flag) for data retention
 *   - Supports bulk operations for efficiency
 *   - Manages cross-table synchronization (e.g., PMC C&E <-> DeptEntity)
 * 
 * KEY MODELS:
 *   - DeptMaster: Main department entity
 *   - DeptStatistic: Statistics/KPIs within a department
 *   - DeptEntity: Projects/entities within a statistic
 *   - PmcProject, PmcMilestone: General PMC project tracking
 *   - PmcConsultancyEntity: C&E service-specific PMC projects
 *   - PmcSliceMeta: Base metadata for all segments (DPR, BMS, Execution)
 *   - PmcDprMeta, PmcBmsMeta, PmcExecutionMeta: Segment-specific metadata
 *   - PmcCeMilestone: Milestones for C&E projects
 *   - BusinessDevelopmentTable, BusinessDevelopmentMilestones: BD pipeline
 *   - OMDGRSolar, OMDGRSolarBESS: O&M tracking for renewable projects
 *   - EntityDocs, EntityCorrespondence, EntityIssues: Supporting data
 * 
 * COMMON PATTERNS USED:
 *   1. Async/await for database operations
 *   2. Standard REST responses: { success: boolean, message: string, data: object }
 *   3. Error handling with try-catch and HTTP status codes
 *   4. Validation of required fields before processing
 *   5. Soft deletes using is_active flag instead of hard deletes
 *   6. Timestamp tracking with createdAt/updatedAt
 *   7. Bulk operations for performance
 *   8. Transaction support for complex multi-table operations
 * 
 * MIGRATION NOTES:
 *   - This file consolidates functions previously in:
 *     * pmc_slice_controller.js (PMC slice metadata CRUD)
 *     * pmc_ce_milestone_controller.js (PMC C&E milestone operations)
 *   - Route files updated to import from this centralized controller
 *   - Old controller files removed to maintain single source of truth
 * 
 * ==========================================
 */

const logger = require('../logger');
const { models } = require('../models');
const { v5: uuidv5 } = require('uuid');

const EXECUTION_ENTITY_NAMESPACE = '8b58c497-6e6e-4b3c-a59d-0bf40f269f88';

function normalizePmcSegment(segment) {
  const seg = String(segment || '').trim().toLowerCase();
  if (!seg) return '';
  if (seg.includes('bms')) return 'pmc-bms';
  if (seg.includes('exec')) return 'pmc-execution';
  if (seg.includes('dpr') || seg.includes('pfr')) return 'pmc_dpr';
  return seg;
}

function getPmcSegmentAliases(segment) {
  const raw = String(segment || '').trim();
  const normalized = normalizePmcSegment(raw);
  const aliases = new Set();

  if (raw) aliases.add(raw);
  if (normalized) aliases.add(normalized);

  if (normalized === 'pmc_dpr') {
    ['pmc_dpr', 'pmc_dpr_pfr', 'pmc-dpr-pfr', 'pmc-dpr', 'dpr', 'dpr_pfr', 'dpr-pfr'].forEach((v) => aliases.add(v));
  } else if (normalized === 'pmc-bms') {
    ['pmc-bms', 'pmc_bms', 'bms'].forEach((v) => aliases.add(v));
  } else if (normalized === 'pmc-execution') {
    ['pmc-execution', 'pmc_execution', 'execution'].forEach((v) => aliases.add(v));
  }

  return Array.from(aliases).filter(Boolean);
}

function inferTypesOfService(types, segment) {
  const list = Array.isArray(types)
    ? types
    : (types ? [types] : []);

  const normalized = Array.from(new Set(
    list
      .map((t) => String(t || '').trim().toUpperCase())
      .filter(Boolean)
      .map((t) => {
        if (t === 'PFR' || t === 'DPR/PFR' || t === 'DPR-PFR' || t === 'DPR_PFR') return 'DPR';
        if (t === 'C&E') return 'EXECUTION';
        return t;
      })
  ));

  if (normalized.length) return normalized;

  const seg = normalizePmcSegment(segment);
  if (seg === 'pmc_dpr') return ['DPR'];
  if (seg === 'pmc-bms') return ['BMS'];
  if (seg === 'pmc-execution') return ['EXECUTION'];
  return [];
}

function normalizeProjectKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function resolveUserDeptAccessLevel(user, deptId) {
  if (!user || !deptId) return 'none';
  if (user.role === 'admin') return 'head';

  try {
    const access = await models.UserEditAccess.findOne({
      where: { user_id: user.user_id, dept_id: deptId },
      attributes: ['can_edit', 'access_level'],
    });

    const level = String(access?.access_level || '').trim().toLowerCase();
    if (level === 'view' || level === 'edit' || level === 'head') return level;
    return access?.can_edit === true ? 'edit' : 'view';
  } catch (err) {
    return 'none';
  }
}

function buildExecutionEntityId(projectName) {
  const normalized = normalizeProjectKey(projectName);
  if (!normalized) return null;
  return uuidv5(`pmc-execution:${normalized}`, EXECUTION_ENTITY_NAMESPACE);
}

function resolvePmcEntryIdForSliceItem(item, segment, fallbackId = null) {
  const src = item || {};
  const isBlank = (v) => v == null || String(v).trim() === '' || String(v).toLowerCase() === 'null' || String(v).toLowerCase() === 'undefined';
  if (Object.prototype.hasOwnProperty.call(src, 'pmc_entry_id')) {
    if (!isBlank(src.pmc_entry_id)) return src.pmc_entry_id;
    // For execution, never persist a blank id; fallback to existing/stable id.
    if (normalizePmcSegment(segment) !== 'pmc-execution') return null;
  }
  if (!isBlank(fallbackId)) return fallbackId;
  if (normalizePmcSegment(segment) === 'pmc-execution') {
    return buildExecutionEntityId(src.project_name || src.projectName || null);
  }
  return null;
}

// Get PMC donut chart data
exports.getPmcDonutChartData = async (req, res) => {
  try {
    // Example: Group projects by service_type and count them
    const projectCounts = await PmcProject.findAll({
      attributes: [
        'service_type',
        [sequelize.fn('COUNT', sequelize.col('pmc_entry_id')), 'count']
      ],
      group: ['service_type']
    });

    // Example: For Consultancy & Engineering Services, group by project_name
    const consultancyCounts = await PmcConsultancyEntity.findAll({
      attributes: [
        'project_name',
        [sequelize.fn('COUNT', sequelize.col('pmc_ce_entity_id')), 'count']
      ],
      group: ['project_name']
    });

    return res.status(200).json({
      success: true,
      pmcProjects: projectCounts,
      consultancy: consultancyCounts
    });
  } catch (error) {
    console.error('Error fetching PMC donut chart data:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fetching PMC donut chart data',
      error: error.message
    });
  }
};

// Slice metadata (DPR/PFR, BMS, C&E-like) endpoints
exports.getPmcSliceMetaBySegment = async (req, res) => {
  try {
    const { segment } = req.params;
    const segmentAliases = getPmcSegmentAliases(segment);
    const normalizedSegment = normalizePmcSegment(segment);
    const whereBySegment = segmentAliases.length > 1
      ? { segment: { [Op.in]: segmentAliases } }
      : { segment: (segmentAliases[0] || segment) };

    const baseItems = await models.PmcSliceMeta.findAll({ where: whereBySegment });

    const extraItems = [];
    try {
      const segLower = String(normalizedSegment || segment || '').toLowerCase();
      if (segLower.includes('dpr') && models.PmcDprMeta) {
        const rows = await models.PmcDprMeta.findAll({ where: whereBySegment });
        rows.forEach((r) => {
          const o = r.toJSON();
          extraItems.push({
            pmc_slice_meta_id: o.pmc_dpr_meta_id || null,
            segment: o.segment || normalizedSegment || segment,
            pmc_entry_id: o.pmc_entry_id || null,
            project_name: o.project_name || '',
            project_capacity: null,
            number_of_projects: o.number_of_projects || null,
            fields: o.fields || [],
            types_of_service: ['DPR'],
          });
        });
      }
      if (segLower.includes('bms') && models.PmcBmsMeta) {
        const rows = await models.PmcBmsMeta.findAll({ where: whereBySegment });
        rows.forEach((r) => {
          const o = r.toJSON();
          extraItems.push({
            pmc_slice_meta_id: o.pmc_bms_meta_id || null,
            segment: o.segment || normalizedSegment || segment,
            pmc_entry_id: o.pmc_entry_id || null,
            project_name: o.project_name || '',
            project_capacity: null,
            number_of_projects: o.number_of_projects || null,
            fields: o.fields || [],
            types_of_service: ['BMS'],
          });
        });
      }
      if (segLower.includes('execution') && models.PmcExecutionMeta) {
        const rows = await models.PmcExecutionMeta.findAll({ where: whereBySegment });
        rows.forEach((r) => {
          const o = r.toJSON();
          extraItems.push({
            pmc_slice_meta_id: o.pmc_execution_meta_id || null,
            segment: o.segment || normalizedSegment || segment,
            pmc_entry_id: o.pmc_entry_id || null,
            project_name: o.project_name || '',
            project_capacity: o.project_capacity || null,
            fields: o.fields || [],
            types_of_service: ['EXECUTION'],
          });
        });
      }
    } catch (e) {
      console.warn('Error fetching extra slice meta', e);
    }

    const enrichedBase = await Promise.all(
      baseItems.map(async (it) => {
        const row = it.toJSON();
        row.documents = [];
        row.correspondences = [];
        row.milestones = [];

        // Slice editor should not fail if PMCCE schema differs (older/newer DBs).
        // Keep these best-effort and swallow query errors.
        if (row.pmc_entry_id) {
          try {
            row.documents = await models.PmcCeDocument.findAll({ where: { pmc_ce_entry_id: row.pmc_entry_id } });
          } catch (e) { /* non-fatal */ }
          try {
            row.correspondences = await models.PmcCeCorrespondence.findAll({ where: { pmc_ce_entry_id: row.pmc_entry_id } });
          } catch (e) { /* non-fatal */ }
          try {
            row.milestones = await models.PmcCeMilestone.findAll({ where: { pmc_ce_entity_id: row.pmc_entry_id } });
          } catch (e) { /* non-fatal */ }
        }

        row.types_of_service = inferTypesOfService(row.types_of_service || row.type_of_service || [], row.segment || normalizedSegment);
        return row;
      })
    );

    const baseIds = new Set(
      enrichedBase
        .map((r) => String(r.pmc_slice_meta_id || '').trim())
        .filter(Boolean)
    );

    // Also dedupe by normalized project name to avoid showing the same
    // project multiple times when there are several execution-meta rows
    // (or mismatched IDs) for the same project.
    const normalizeName = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const baseNames = new Set(
      enrichedBase
        .map((r) => normalizeName(r.project_name))
        .filter(Boolean)
    );

    const seenExtraNames = new Set();
    const dedupedExtra = extraItems
      .filter((r) => {
        const id = String(r.pmc_slice_meta_id || '').trim();
        const nameNorm = normalizeName(r.project_name);
        if (id && baseIds.has(id)) return false;
        if (nameNorm && baseNames.has(nameNorm)) return false;
        if (nameNorm && seenExtraNames.has(nameNorm)) return false;
        if (nameNorm) seenExtraNames.add(nameNorm);
        return true;
      })
      .map((r) => ({
        ...r,
        types_of_service: inferTypesOfService(r.types_of_service || r.type_of_service || [], r.segment || normalizedSegment),
      }));

    const all = enrichedBase.concat(dedupedExtra);
    res.json({ ok: true, items: all });
  } catch (err) {
    console.error('getSliceMetaBySegment', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

exports.getPmcSliceMetaItem = async (req, res) => {
  try {
    const { id } = req.params;
    const it = await models.PmcSliceMeta.findByPk(id);
    if (!it) return res.status(404).json({ ok: false, error: 'Not found' });
    const row = it.toJSON();
    row.documents = [];
    row.correspondences = [];
    row.milestones = [];
    if (row.pmc_entry_id) {
      try {
        row.documents = await models.PmcCeDocument.findAll({ where: { pmc_ce_entry_id: row.pmc_entry_id } });
      } catch (e) { /* non-fatal */ }
      try {
        row.correspondences = await models.PmcCeCorrespondence.findAll({ where: { pmc_ce_entry_id: row.pmc_entry_id } });
      } catch (e) { /* non-fatal */ }
      try {
        row.milestones = await models.PmcCeMilestone.findAll({ where: { pmc_ce_entity_id: row.pmc_entry_id } });
      } catch (e) { /* non-fatal */ }
    }
    res.json({ ok: true, item: row });
  } catch (err) {
    console.error('getSliceMetaItem', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

exports.deletePmcSliceMetaItem = async (req, res) => {
  try {
    const { id } = req.params;
    const qSeg = String(req.query.segment || '').trim();
    const qProject = String(req.query.project_name || '').trim();

    let deleted = 0;
    let seg = '';

    const existing = await models.PmcSliceMeta.findByPk(id);
    if (existing) {
      seg = String(existing.segment || '').toLowerCase();
      deleted += await models.PmcSliceMeta.destroy({ where: { pmc_slice_meta_id: id } });
    }

    const segmentForDelete = normalizePmcSegment(qSeg || seg);

    // Delete from specialized tables by shared id first.
    if (models.PmcDprMeta) {
      deleted += await models.PmcDprMeta.destroy({ where: { pmc_dpr_meta_id: id } });
    }
    if (models.PmcBmsMeta) {
      deleted += await models.PmcBmsMeta.destroy({ where: { pmc_bms_meta_id: id } });
    }
    if (models.PmcExecutionMeta) {
      deleted += await models.PmcExecutionMeta.destroy({ where: { pmc_execution_meta_id: id } });
    }

    // Fallback: if row was stored only in segment table with another ID, delete by project+segment.
    if (deleted === 0 && qProject && segmentForDelete) {
      const aliases = getPmcSegmentAliases(segmentForDelete);
      const segmentWhere = aliases.length > 1 ? { [Op.in]: aliases } : segmentForDelete;
      const nameWhere = sequelize.where(
        sequelize.fn('LOWER', sequelize.col('project_name')),
        qProject.toLowerCase()
      );

      if (segmentForDelete.includes('dpr') && models.PmcDprMeta) {
        deleted += await models.PmcDprMeta.destroy({ where: { segment: segmentWhere, [Op.and]: [nameWhere] } });
      } else if (segmentForDelete.includes('bms') && models.PmcBmsMeta) {
        deleted += await models.PmcBmsMeta.destroy({ where: { segment: segmentWhere, [Op.and]: [nameWhere] } });
      } else if (segmentForDelete.includes('execution') && models.PmcExecutionMeta) {
        deleted += await models.PmcExecutionMeta.destroy({ where: { segment: segmentWhere, [Op.and]: [nameWhere] } });
      }

      // Keep base table aligned when available.
      deleted += await models.PmcSliceMeta.destroy({ where: { segment: segmentWhere, [Op.and]: [nameWhere] } });
    }

    if (!deleted) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, deletedId: id, deletedCount: deleted });
  } catch (err) {
    console.error('deletePmcSliceMetaItem', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

exports.savePmcSliceMeta = async (req, res) => {
  try {
    const { items, segment, replaceAll } = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'items array required' });

    const cleanedItems = items.filter((it) => {
      const name = String((it && it.project_name) || '').trim();
      return name.length > 0;
    });

    // Guard against accidental full wipe when UI sends only blank rows.
    if (replaceAll === true && items.length > 0 && cleanedItems.length === 0) {
      return res.status(400).json({
        ok: false,
        error: 'At least one non-empty project_name is required when saving with replaceAll.',
      });
    }

    const results = [];
    const fallbackSegment = String(segment || (cleanedItems[0] && cleanedItems[0].segment) || '').trim();

    function normalizeSliceValuesForSegment(rawItem, seg, fallbackValues = {}) {
      const normalizedSeg = normalizePmcSegment(seg);
      const parsedCapacity = Number(rawItem && rawItem.project_capacity);
      const parsedProjects = parseInt(rawItem && rawItem.number_of_projects, 10);
      const parsedLand = parseInt(rawItem && rawItem.land, 10);

      if (normalizedSeg === 'pmc-execution') {
        return {
          project_capacity: (Number.isFinite(parsedCapacity) && parsedCapacity > 0)
            ? parsedCapacity
            : (fallbackValues.project_capacity ?? null),
          number_of_projects: null,
          land: (Number.isFinite(parsedLand) && parsedLand > 0)
            ? parsedLand
            : (fallbackValues.land ?? null),
        };
      }

      return {
        project_capacity: null,
        number_of_projects: (Number.isFinite(parsedProjects) && parsedProjects > 0) ? parsedProjects : 1,
        land: null,
      };
    }

    // helper: create/update corresponding slice meta rows for other selected types
    async function syncOtherSegments(itObj, sourceSegment, baseRecord) {
      try {
        logger.info && logger.info('syncOtherSegments called', { project_name: itObj.project_name, sourceSegment });
        const types = inferTypesOfService(itObj.types_of_service || itObj.type_of_service || [], sourceSegment);
        const mapTypeToSeg = (t) => {
          if (t === 'DPR') return 'pmc_dpr';
          if (t === 'BMS') return 'pmc-bms';
          if (t === 'EXECUTION') return 'pmc-execution';
          return null;
        };

        const normalizedSource = normalizePmcSegment(sourceSegment);

        for (const t of types) {
          logger.info && logger.info('syncOtherSegments processing type', { type: t, project_name: itObj.project_name });
          const targetSeg = mapTypeToSeg(t);
          if (!targetSeg) continue;
          const normalizedTarget = normalizePmcSegment(targetSeg);
          if (!normalizedTarget) continue;
          if (normalizedTarget === normalizedSource) continue; // already handled by primary save

          const aliases = getPmcSegmentAliases(targetSeg);
          // find existing by project name in target segment
          const existingTarget = await models.PmcSliceMeta.findOne({
            where: {
              segment: aliases.length > 1 ? { [Op.in]: aliases } : targetSeg,
              [Op.and]: [
                sequelize.where(
                  sequelize.fn('LOWER', sequelize.col('project_name')),
                  String((itObj.project_name || '').toLowerCase())
                ),
              ],
            },
            order: [['updatedAt', 'DESC']],
          });

          if (existingTarget) {
            logger.info && logger.info('syncOtherSegments found existing target', { targetSeg, pmc_slice_meta_id: existingTarget.pmc_slice_meta_id });
            const targetValues = normalizeSliceValuesForSegment(itObj, targetSeg, existingTarget);
            try {
              await existingTarget.update({
                project_name: itObj.project_name,
                project_capacity: targetValues.project_capacity,
                number_of_projects: targetValues.number_of_projects,
                loa_date: itObj.loa_date || existingTarget.loa_date || null,
                scod: itObj.scod || existingTarget.scod || null,
                land: targetValues.land,
                fields: itObj.fields || existingTarget.fields || [],
                pmc_entry_id: resolvePmcEntryIdForSliceItem(itObj, targetSeg, existingTarget.pmc_entry_id),
              });
            } catch (e) { logger.warn && logger.warn('syncOtherSegments update target failed', { err: e && e.message }); }

            // update specialized table
            try {
              if (normalizedTarget.includes('dpr') && models.PmcDprMeta) {
                await models.PmcDprMeta.upsert({
                  pmc_dpr_meta_id: existingTarget.pmc_slice_meta_id,
                  segment: existingTarget.segment,
                  pmc_entry_id: existingTarget.pmc_entry_id,
                  project_name: existingTarget.project_name,
                  number_of_projects: targetValues.number_of_projects,
                  loa_date: itObj.loa_date || null,
                  scod: itObj.scod || null,
                  fields: itObj.fields || existingTarget.fields || [],
                });
              } else if (normalizedTarget.includes('bms') && models.PmcBmsMeta) {
                await models.PmcBmsMeta.upsert({
                  pmc_bms_meta_id: existingTarget.pmc_slice_meta_id,
                  segment: existingTarget.segment,
                  pmc_entry_id: existingTarget.pmc_entry_id,
                  project_name: existingTarget.project_name,
                  number_of_projects: targetValues.number_of_projects,
                  loa_date: itObj.loa_date || null,
                  scod: itObj.scod || null,
                  fields: itObj.fields || existingTarget.fields || [],
                });
              } else if (normalizedTarget.includes('execution') && models.PmcExecutionMeta) {
                await models.PmcExecutionMeta.upsert({
                  pmc_execution_meta_id: existingTarget.pmc_slice_meta_id,
                  segment: existingTarget.segment,
                  pmc_entry_id: existingTarget.pmc_entry_id,
                  project_name: existingTarget.project_name,
                  project_capacity: targetValues.project_capacity,
                  loa_date: itObj.loa_date || null,
                  scod: itObj.scod || null,
                  land: targetValues.land,
                  fields: itObj.fields || existingTarget.fields || [],
                });
              }
            } catch (e) { logger.warn && logger.warn('syncOtherSegments upsert specialized failed', { err: e && e.message }); }
            continue;
          }

          // create new slice meta for the target segment
          try {
            logger.info && logger.info('syncOtherSegments creating target slice', { targetSeg, project_name: itObj.project_name });
            const targetValues = normalizeSliceValuesForSegment(itObj, targetSeg, {});
            const createdTarget = await models.PmcSliceMeta.create({
              segment: targetSeg,
              pmc_entry_id: resolvePmcEntryIdForSliceItem(itObj, targetSeg, null),
              project_name: itObj.project_name || '',
              project_capacity: targetValues.project_capacity,
              number_of_projects: targetValues.number_of_projects,
              loa_date: itObj.loa_date || null,
              scod: itObj.scod || null,
              land: targetValues.land,
              fields: itObj.fields || [],
            });

            try {
              logger.info && logger.info('syncOtherSegments created target slice', { targetSeg, pmc_slice_meta_id: createdTarget.pmc_slice_meta_id });
              if (normalizedTarget.includes('dpr') && models.PmcDprMeta) {
                await models.PmcDprMeta.create({
                  pmc_dpr_meta_id: createdTarget.pmc_slice_meta_id,
                  segment: createdTarget.segment,
                  pmc_entry_id: createdTarget.pmc_entry_id,
                  project_name: createdTarget.project_name,
                  number_of_projects: targetValues.number_of_projects,
                  loa_date: itObj.loa_date || null,
                  scod: itObj.scod || null,
                  fields: itObj.fields || [],
                });
              } else if (normalizedTarget.includes('bms') && models.PmcBmsMeta) {
                await models.PmcBmsMeta.create({
                  pmc_bms_meta_id: createdTarget.pmc_slice_meta_id,
                  segment: createdTarget.segment,
                  pmc_entry_id: createdTarget.pmc_entry_id,
                  project_name: createdTarget.project_name,
                  number_of_projects: targetValues.number_of_projects,
                  loa_date: itObj.loa_date || null,
                  scod: itObj.scod || null,
                  fields: itObj.fields || [],
                });
              } else if (normalizedTarget.includes('execution') && models.PmcExecutionMeta) {
                await models.PmcExecutionMeta.create({
                  pmc_execution_meta_id: createdTarget.pmc_slice_meta_id,
                  segment: createdTarget.segment,
                  pmc_entry_id: createdTarget.pmc_entry_id,
                  project_name: createdTarget.project_name,
                  project_capacity: targetValues.project_capacity,
                  loa_date: itObj.loa_date || null,
                  scod: itObj.scod || null,
                  land: targetValues.land,
                  fields: itObj.fields || [],
                });
              }
            } catch (e) { logger.warn && logger.warn('syncOtherSegments create specialized failed', { err: e && e.message }); }
          } catch (e) {
            logger.warn && logger.warn('syncOtherSegments create target failed', { err: e && e.message });
          }
        }
      } catch (e) { /* ignore overall */ }
    }

    for (const it of cleanedItems) {
      const incomingSegment = it.segment || fallbackSegment || 'pmc';
      const incomingProjectName = String(it.project_name || '').trim();
      const incomingValues = normalizeSliceValuesForSegment(it, incomingSegment, {});

      if (it.pmc_slice_meta_id) {
        const existing = await models.PmcSliceMeta.findByPk(it.pmc_slice_meta_id);
        if (existing) {
          await existing.update({
            project_name: it.project_name,
            project_capacity: incomingValues.project_capacity,
            number_of_projects: incomingValues.number_of_projects,
            loa_date: it.loa_date || null,
            scod: it.scod || null,
            land: incomingValues.land,
            fields: it.fields,
            pmc_entry_id: resolvePmcEntryIdForSliceItem(it, existing.segment, existing.pmc_entry_id),
          });
          results.push(existing.toJSON());
          try {
            if (String(existing.segment || '').toLowerCase().includes('dpr') && models.PmcDprMeta) {
              await models.PmcDprMeta.upsert({
                pmc_dpr_meta_id: existing.pmc_slice_meta_id,
                segment: existing.segment,
                pmc_entry_id: existing.pmc_entry_id,
                project_name: existing.project_name,
                number_of_projects: incomingValues.number_of_projects,
                loa_date: it.loa_date || null,
                scod: it.scod || null,
                fields: it.fields || [],
              });
            } else if (String(existing.segment || '').toLowerCase().includes('bms') && models.PmcBmsMeta) {
              await models.PmcBmsMeta.upsert({
                pmc_bms_meta_id: existing.pmc_slice_meta_id,
                segment: existing.segment,
                pmc_entry_id: existing.pmc_entry_id,
                project_name: existing.project_name,
                number_of_projects: incomingValues.number_of_projects,
                loa_date: it.loa_date || null,
                scod: it.scod || null,
                fields: it.fields || [],
              });
            } else if (String(existing.segment || '').toLowerCase().includes('execution') && models.PmcExecutionMeta) {
              await models.PmcExecutionMeta.upsert({
                pmc_execution_meta_id: existing.pmc_slice_meta_id,
                segment: existing.segment,
                pmc_entry_id: existing.pmc_entry_id,
                project_name: existing.project_name,
                project_capacity: incomingValues.project_capacity,
                loa_date: it.loa_date || null,
                scod: it.scod || null,
                land: incomingValues.land,
                fields: it.fields || [],
              });
            }
          } catch (e) {
            // non-fatal
          }
          try { await syncOtherSegments(it, existing.segment, existing); } catch (e) { /* non-fatal */ }
          continue;
        }
      }

      // If no explicit ID is provided but the same project already exists in this segment,
      // update the most recent row instead of creating duplicates.
      if (!it.pmc_slice_meta_id && incomingProjectName) {
        const segmentAliases = getPmcSegmentAliases(incomingSegment);
        const existingByProject = await models.PmcSliceMeta.findOne({
          where: {
            segment: segmentAliases.length > 1 ? { [Op.in]: segmentAliases } : incomingSegment,
            [Op.and]: [
              sequelize.where(
                sequelize.fn('LOWER', sequelize.col('project_name')),
                incomingProjectName.toLowerCase()
              ),
            ],
          },
          order: [['updatedAt', 'DESC']],
        });

        if (existingByProject) {
          const existingByProjectValues = normalizeSliceValuesForSegment(it, existingByProject.segment, existingByProject);
          await existingByProject.update({
            project_name: incomingProjectName,
            project_capacity: existingByProjectValues.project_capacity,
            number_of_projects: existingByProjectValues.number_of_projects,
            loa_date: it.loa_date || null,
            scod: it.scod || null,
            land: existingByProjectValues.land,
            fields: it.fields,
            pmc_entry_id: resolvePmcEntryIdForSliceItem(it, existingByProject.segment, existingByProject.pmc_entry_id),
          });

          try {
            const seg = String(existingByProject.segment || '').toLowerCase();
            if (seg.includes('dpr') && models.PmcDprMeta) {
              await models.PmcDprMeta.upsert({
                pmc_dpr_meta_id: existingByProject.pmc_slice_meta_id,
                segment: existingByProject.segment,
                pmc_entry_id: existingByProject.pmc_entry_id,
                project_name: existingByProject.project_name,
                number_of_projects: existingByProjectValues.number_of_projects,
                loa_date: it.loa_date || null,
                scod: it.scod || null,
                fields: it.fields || [],
              });
            } else if (seg.includes('bms') && models.PmcBmsMeta) {
              await models.PmcBmsMeta.upsert({
                pmc_bms_meta_id: existingByProject.pmc_slice_meta_id,
                segment: existingByProject.segment,
                pmc_entry_id: existingByProject.pmc_entry_id,
                project_name: existingByProject.project_name,
                number_of_projects: existingByProjectValues.number_of_projects,
                loa_date: it.loa_date || null,
                scod: it.scod || null,
                fields: it.fields || [],
              });
            } else if (seg.includes('execution') && models.PmcExecutionMeta) {
              await models.PmcExecutionMeta.upsert({
                pmc_execution_meta_id: existingByProject.pmc_slice_meta_id,
                segment: existingByProject.segment,
                pmc_entry_id: existingByProject.pmc_entry_id,
                project_name: existingByProject.project_name,
                project_capacity: existingByProjectValues.project_capacity,
                loa_date: it.loa_date || null,
                scod: it.scod || null,
                land: existingByProjectValues.land,
                fields: it.fields || [],
              });
            }
          } catch (e) {
            // non-fatal
          }

          results.push(existingByProject.toJSON());
          try { await syncOtherSegments(it, existingByProject.segment, existingByProject); } catch (e) { /* non-fatal */ }
          continue;
        }
      }

      const created = await models.PmcSliceMeta.create({
        segment: incomingSegment,
        pmc_entry_id: resolvePmcEntryIdForSliceItem(it, incomingSegment, null),
        project_name: incomingProjectName,
        project_capacity: incomingValues.project_capacity,
        number_of_projects: incomingValues.number_of_projects,
        loa_date: it.loa_date || null,
        scod: it.scod || null,
        land: incomingValues.land,
        fields: it.fields || [],
      });
      try {
        const seg = String(created.segment || '').toLowerCase();
        if (seg.includes('dpr') && models.PmcDprMeta) {
          await models.PmcDprMeta.create({
            pmc_dpr_meta_id: created.pmc_slice_meta_id,
            segment: created.segment,
            pmc_entry_id: created.pmc_entry_id,
            project_name: created.project_name,
            number_of_projects: incomingValues.number_of_projects,
            loa_date: it.loa_date || null,
            scod: it.scod || null,
            fields: it.fields || [],
          });
        } else if (seg.includes('bms') && models.PmcBmsMeta) {
          await models.PmcBmsMeta.create({
            pmc_bms_meta_id: created.pmc_slice_meta_id,
            segment: created.segment,
            pmc_entry_id: created.pmc_entry_id,
            project_name: created.project_name,
            number_of_projects: incomingValues.number_of_projects,
            loa_date: it.loa_date || null,
            scod: it.scod || null,
            fields: it.fields || [],
          });
        } else if (seg.includes('execution') && models.PmcExecutionMeta) {
          await models.PmcExecutionMeta.create({
            pmc_execution_meta_id: created.pmc_slice_meta_id,
            segment: created.segment,
            pmc_entry_id: created.pmc_entry_id,
            project_name: created.project_name,
            project_capacity: incomingValues.project_capacity,
            loa_date: it.loa_date || null,
            scod: it.scod || null,
            land: incomingValues.land,
            fields: it.fields || [],
          });
        }
      } catch (e) {
        // non-fatal
      }
      results.push(created.toJSON());
      try { await syncOtherSegments(it, created.segment, created); } catch (e) { /* non-fatal */ }
    }

    // When editor sends full segment payload, delete rows removed from the form.
    if (replaceAll === true && fallbackSegment) {
      const segmentAliases = getPmcSegmentAliases(fallbackSegment);
      const whereBySegment = segmentAliases.length > 1
        ? { segment: { [Op.in]: segmentAliases } }
        : { segment: (segmentAliases[0] || fallbackSegment) };

      const keepIds = new Set(
        results
          .map((r) => String(r.pmc_slice_meta_id || '').trim())
          .filter(Boolean)
      );

      const existingRows = await models.PmcSliceMeta.findAll({
        attributes: ['pmc_slice_meta_id'],
        where: whereBySegment,
      });

      const deleteIds = existingRows
        .map((r) => String(r.pmc_slice_meta_id || '').trim())
        .filter((id) => id && !keepIds.has(id));

      if (deleteIds.length) {
        await models.PmcSliceMeta.destroy({ where: { pmc_slice_meta_id: deleteIds } });

        const seg = String(normalizePmcSegment(fallbackSegment) || fallbackSegment).toLowerCase();
        try {
          if (seg.includes('dpr') && models.PmcDprMeta) {
            await models.PmcDprMeta.destroy({ where: { pmc_dpr_meta_id: deleteIds } });
          } else if (seg.includes('bms') && models.PmcBmsMeta) {
            await models.PmcBmsMeta.destroy({ where: { pmc_bms_meta_id: deleteIds } });
          } else if (seg.includes('execution') && models.PmcExecutionMeta) {
            await models.PmcExecutionMeta.destroy({ where: { pmc_execution_meta_id: deleteIds } });
          }
        } catch (e) {
          // non-fatal
        }
      }
    }

    res.json({ ok: true, items: results });
  } catch (err) {
    console.error('saveSliceMeta', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

exports.cleanupPmcExecution = async (req, res) => {
  try {
    const { segment = 'pmc-execution' } = req.body;
    const sliceMetaRecords = await models.PmcSliceMeta.findAll({ where: { segment } });
    const executionMetaRecords = await models.PmcExecutionMeta?.findAll({ where: { segment } }) || [];

    const deletedCount = sliceMetaRecords.length + executionMetaRecords.length;

    if (deletedCount === 0) {
      return res.json({ ok: true, message: 'No records found to delete', deletedCount: 0 });
    }

    await models.PmcSliceMeta.destroy({ where: { segment } });
    if (models.PmcExecutionMeta) {
      await models.PmcExecutionMeta.destroy({ where: { segment } });
    }

    res.json({
      ok: true,
      message: `Deleted ${deletedCount} records from pmc-execution`,
      deletedCount,
      breakdown: {
        pmc_slice_meta: sliceMetaRecords.length,
        pmc_execution_meta: executionMetaRecords.length,
      },
    });
  } catch (err) {
    console.error('cleanupPmcExecution', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};

const {
  DeptMaster,
  DeptStatistic,
  DeptEntity,
  EntityDocs,
  EntityCorrespondence,
  UserEditAccess,
  EntityFields,
  EntityIssues,
  User,
  ContractsTable,
  TenderRegister,
  BusinessDevelopmentTable,
  BusinessDevelopmentMilestones,
  OMDGR,
  REIADocuments,
  OMProjectTypeMapping,
  OMDGRSolarBESS,
  OMDGRSolar,
  OmProjectTypeIssuesActions,
  PmcProject,
  PmcMilestone,
  PmcConsultancyEntity,
  PmcConsultancyField,
  PmcCeDocument,
  PmcCeCorrespondence,
  PmcSliceMeta,
  OwnProject,
  QaRegisteredProject,
  QaBbu,
  QaMdcc,
} = require("../models").models;

const { sequelize } = require("../models");

const { Sequelize, Op } = require("sequelize");
const { streamExcel } = require("../utils/helper");

exports.getMilestonesByBusinessDevelopmentEntry = async (req, res) => {
  try {
    const { bd_entry_id } = req.params;

    if (!bd_entry_id) {
      return res.status(400).json({
        success: false,
        message: "bd_entry_id is required in the URL.",
      });
    }

    const milestones = await BusinessDevelopmentMilestones.findAll({
      where: { bd_entry_id },
      order: [["milestone_date", "ASC"]], // Optional: order by date
    });

    return res.status(200).json({
      success: true,
      message: `Milestones for bd_entry_id ${bd_entry_id} fetched successfully.`,
      data: milestones,
    });
  } catch (error) {
    console.error("Error fetching milestones:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching milestones.",
      error: error.message,
    });
  }
};

exports.editBusinessDevelopmentEntry = async (req, res) => {
  try {
    const { bd_entry_id } = req.params;

    // Extract fields from request body
    const {
      business_partner,
      location,
      action_plan,
      action_pending_with,
      anticipated_capacity,
      target,
      connectivity,
      technology,
      buyer,
    } = req.body;

    // Check if the entry exists
    const entry = await BusinessDevelopmentTable.findByPk(bd_entry_id);

    if (!entry) {
      return res.status(404).json({
        success: false,
        message: "Business development entry not found.",
      });
    }

    // Update the entry
    await entry.update({
      business_partner,
      location,
      action_plan,
      action_pending_with,
      anticipated_capacity,
      target,
      connectivity,
      technology,
      buyer,
    });

    return res.status(200).json({
      success: true,
      message: "Entry updated successfully.",
      data: entry,
    });
  } catch (error) {
    console.error("Error updating business development entry:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while updating the entry.",
      error: error.message,
    });
  }
};

exports.editBusinessDevelopmentMilestone = async (req, res) => {
  try {
    const { milestone_id } = req.params;

    // Extract fields from request body
    const { milestone_name, milestone_date, milestone_status, is_active } = req.body;

    // Find milestone by primary key (milestone_id)
    const milestone = await BusinessDevelopmentMilestones.findOne({
      where: { milestone_id },
    });

    if (!milestone) {
      return res.status(404).json({
        success: false,
        message: "Milestone not found.",
      });
    }

    // Update the milestone fields
    await milestone.update({
      milestone_name,
      milestone_date,
      milestone_status,
      is_active,
    });

    return res.status(200).json({
      success: true,
      message: "Milestone updated successfully.",
      data: milestone,
    });
  } catch (error) {
    console.error("Error updating milestone:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while updating the milestone.",
      error: error.message,
    });
  }
};

exports.getAllBusinessDevelopmentEntries = async (req, res) => {
  try {
    const entries = await BusinessDevelopmentTable.findAll();

    return res.status(200).json({
      success: true,
      message: "Business development entries fetched successfully.",
      data: entries,
    });
  } catch (error) {
    console.error("Error fetching business development entries:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching entries.",
      error: error.message,
    });
  }
};

exports.createBusinessDevelopmentMilestone = async (req, res) => {
  try {
    const {
      bd_entry_id,
      milestone_name,
      milestone_date,
      milestone_status = "in-progress",
      is_active = true, // default true if not provided
    } = req.body;

    // Validate required fields
    if (!bd_entry_id || !milestone_name || !milestone_date) {
      return res.status(400).json({
        success: false,
        message:
          "bd_entry_id, milestone_name, and milestone_date are required.",
      });
    }

    // Check if bd_entry_id exists in bd_table
    const existingEntry = await BusinessDevelopmentTable.findByPk(bd_entry_id);
    if (!existingEntry) {
      return res.status(404).json({
        success: false,
        message:
          "No business development entry found with the given bd_entry_id.",
      });
    }

    // Create the milestone
    const newMilestone = await BusinessDevelopmentMilestones.create({
      bd_entry_id,
      milestone_name,
      milestone_date,
      milestone_status,
      is_active,
    });

    return res.status(201).json({
      success: true,
      message: "Milestone created successfully.",
      data: newMilestone,
    });
  } catch (error) {
    console.error("Error creating milestone:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while creating the milestone.",
      error: error.message,
    });
  }
};

/**
 * Controller to create a Business Development Entry
 *
 */
exports.createBusinessDevelopmentEntry = async (req, res) => {
  try {
    const {
      business_partner,
      location,
      action_plan,
      action_pending_with,
      anticipated_capacity,
      target,
      connectivity,
      technology,
      buyer,
    } = req.body;

    // Basic validation
    if (
      !business_partner ||
      !location ||
      !action_plan ||
      !action_pending_with ||
      anticipated_capacity === null ||
      anticipated_capacity === undefined ||
      !target
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required.",
      });
    }

    // Validate and convert anticipated_capacity to number
    const capacity = parseFloat(anticipated_capacity);
    if (isNaN(capacity)) {
      return res.status(400).json({
        success: false,
        message: "Anticipated capacity must be a valid number.",
      });
    }

    // Create new entry
    const newEntry = await BusinessDevelopmentTable.create({
      business_partner,
      location,
      action_plan,
      action_pending_with,
      anticipated_capacity: capacity,
      target,
      connectivity: connectivity || null,
      technology: technology || null,
      buyer: buyer || null,
    });

    return res.status(201).json({
      success: true,
      message: "Business development entry created successfully.",
      data: newEntry,
    });
  } catch (error) {
    console.error("Error creating BD entry:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while creating the entry.",
      error: error.message,
    });
  }
};

exports.deleteBusinessDevelopmentEntry = async (req, res) => {
  try {
    const { bd_entry_id } = req.params;

    // Validate bd_entry_id
    if (!bd_entry_id) {
      return res.status(400).json({
        success: false,
        message: "Business development entry ID is required.",
      });
    }

    // Use a transaction to ensure atomicity
    await sequelize.transaction(async (t) => {
      // Delete associated milestones first to avoid FK constraint violation
      await BusinessDevelopmentMilestones.destroy({
        where: { bd_entry_id },
        transaction: t,
      });

      // Now delete the entry
      const deletedEntry = await BusinessDevelopmentTable.destroy({
        where: { bd_entry_id },
        transaction: t,
      });

      // Check if an entry was deleted
      if (!deletedEntry) {
        throw new Error("EntryNotFound");
      }
    });

    return res.status(200).json({
      success: true,
      message: "Business development entry deleted successfully.",
    });
  } catch (error) {
    if (error.message === "EntryNotFound") {
      return res.status(404).json({
        success: false,
        message: "Business development entry not found.",
      });
    }
    console.error("Error deleting BD entry:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while deleting the entry.",
      error: error.message,
    });
  }
};

exports.deleteBusinessDevelopmentMilestone = async (req, res) => {
  try {
    const { milestone_id } = req.params;

    const deletedCount = await BusinessDevelopmentMilestones.destroy({
      where: {
        milestone_id,
      },
    });

    if (deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Milestone not found or already deleted.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Milestone deleted successfully.",
    });
  } catch (error) {
    console.error("Error deleting milestone", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while deleting the milestone.",
      error: error.message,
    });
  }
};

// ──────────────────────────────────────────────
// C&P Own Projects Controllers
// ──────────────────────────────────────────────

/**
 * Get all C&P Own Projects entries
 */
exports.getAllCpOwnProjects = async (req, res) => {
  try {
    const entries = await OwnProject.findAll({
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({
      success: true,
      message: "C&P own projects fetched successfully.",
      data: entries,
    });
  } catch (error) {
    console.error("Error fetching C&P own projects:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching entries.",
      error: error.message,
    });
  }
};

/**
 * Get a single C&P Own Project by ID
 */
exports.getOneCpOwnProject = async (req, res) => {
  try {
    const { cp_entry_id } = req.params;

    const entry = await OwnProject.findByPk(cp_entry_id);
    if (!entry) {
      return res.status(404).json({
        success: false,
        message: "C&P own project entry not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "C&P own project fetched successfully.",
      data: entry,
    });
  } catch (error) {
    console.error("Error fetching C&P own project:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching entry.",
      error: error.message,
    });
  }
};

/**
 * Create a new C&P Own Project entry
 */
exports.createCpOwnProject = async (req, res) => {
  try {
    const {
      project_name,
      capacity_mw,
      estimated_cost,
      awarded_cost,
      agreement_no,
      agency,
      date_of_start,
      completion_time,
      remarks,
    } = req.body;

    if (!project_name) {
      return res.status(400).json({
        success: false,
        message: "Project name is required.",
      });
    }

    const newEntry = await OwnProject.create({
      project_name,
      capacity_mw: capacity_mw ? parseFloat(capacity_mw) : null,
      estimated_cost: estimated_cost || null,
      awarded_cost: awarded_cost || null,
      agreement_no: agreement_no || null,
      agency: agency || null,
      date_of_start: date_of_start || null,
      completion_time: completion_time || null,
      remarks: remarks || null,
    });

    return res.status(201).json({
      success: true,
      message: "C&P own project created successfully.",
      data: newEntry,
    });
  } catch (error) {
    console.error("Error creating C&P own project:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while creating the entry.",
      error: error.message,
    });
  }
};

/**
 * Edit a C&P Own Project entry
 */
exports.editCpOwnProject = async (req, res) => {
  try {
    const { cp_entry_id } = req.params;
    const {
      project_name,
      capacity_mw,
      estimated_cost,
      awarded_cost,
      agreement_no,
      agency,
      date_of_start,
      completion_time,
      remarks,
    } = req.body;

    const entry = await OwnProject.findByPk(cp_entry_id);
    if (!entry) {
      return res.status(404).json({
        success: false,
        message: "C&P own project entry not found.",
      });
    }

    await entry.update({
      project_name: project_name ?? entry.project_name,
      capacity_mw: capacity_mw !== undefined ? parseFloat(capacity_mw) : entry.capacity_mw,
      estimated_cost: estimated_cost ?? entry.estimated_cost,
      awarded_cost: awarded_cost ?? entry.awarded_cost,
      agreement_no: agreement_no ?? entry.agreement_no,
      agency: agency ?? entry.agency,
      date_of_start: date_of_start ?? entry.date_of_start,
      completion_time: completion_time ?? entry.completion_time,
      remarks: remarks ?? entry.remarks,
    });

    return res.status(200).json({
      success: true,
      message: "C&P own project updated successfully.",
      data: entry,
    });
  } catch (error) {
    console.error("Error updating C&P own project:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while updating the entry.",
      error: error.message,
    });
  }
};

/**
 * Delete a C&P Own Project entry
 */
exports.deleteCpOwnProject = async (req, res) => {
  try {
    const { cp_entry_id } = req.params;

    const deletedEntry = await OwnProject.destroy({
      where: { cp_entry_id },
    });

    if (!deletedEntry) {
      return res.status(404).json({
        success: false,
        message: "C&P own project entry not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "C&P own project deleted successfully.",
    });
  } catch (error) {
    console.error("Error deleting C&P own project:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while deleting the entry.",
      error: error.message,
    });
  }
};

/**
 * Controller to get user-to-department access mappings.
 *
 * @route GET /api/user-access-mappings
 * @returns {Object} JSON object in the format:
 *   {
 *     "Alice": ["Finance", "HR"],
 *     "Bob": ["IT"]
 *   }
 * @access Protected (depends on your middleware)
 */
exports.getUserDepartmentMappings = async (req, res) => {
  try {
    // Try to fetch with access_level column (may not exist in production if migration
    // 20260528090000 hasn't been run). Fall back gracefully if column is missing.
    let userDepartmentMappings;
    let hasAccessLevel = true;

    try {
      userDepartmentMappings = await UserEditAccess.findAll({
        attributes: ["user_id", "dept_id", "can_edit", "access_level"],
      });
    } catch (colErr) {
      // Column access_level missing — retry without it
      hasAccessLevel = false;
      userDepartmentMappings = await UserEditAccess.findAll({
        attributes: ["user_id", "dept_id", "can_edit"],
      });
    }

    // If no mappings exist, return empty immediately — avoids IN () SQL error
    if (!userDepartmentMappings || userDepartmentMappings.length === 0) {
      return res.json({ mappings: [] });
    }

    const userIds = Array.from(
      new Set(userDepartmentMappings.map((m) => m.user_id))
    );
    const deptIds = Array.from(
      new Set(userDepartmentMappings.map((m) => m.dept_id))
    );

    // Guard: empty arrays cause invalid WHERE user_id IN () SQL in MySQL/PostgreSQL
    if (userIds.length === 0 || deptIds.length === 0) {
      return res.json({ mappings: [] });
    }

    const [users, departments] = await Promise.all([
      User.findAll({
        where: { user_id: userIds },
        attributes: ["user_id", "name"],
      }),
      DeptMaster.findAll({
        where: { dept_id: deptIds },
        attributes: ["dept_id", "dept_name"],
      }),
    ]);

    const userMap = new Map(users.map((u) => [u.user_id, u.name]));
    const deptMap = new Map(
      departments.map((d) => [d.dept_id, d.dept_name])
    );

    const result = userDepartmentMappings
      .map((mapping) => {
        const rawLevel = hasAccessLevel
          ? String(mapping.access_level || "").trim().toLowerCase()
          : "";
        const accessLevel = (rawLevel === "view" || rawLevel === "edit" || rawLevel === "head")
          ? rawLevel
          : (mapping.can_edit !== false ? "edit" : "view");
        return {
        user_id: mapping.user_id,
        user_name: userMap.get(mapping.user_id) || "Unknown",
        dept_id: mapping.dept_id,
        dept_name: deptMap.get(mapping.dept_id) || "Unknown",
        can_edit: accessLevel === "edit" || accessLevel === "head",
        access_level: accessLevel,
      };
      })
      .filter((row) => row.user_name !== "Unknown" && row.dept_name !== "Unknown");

    res.json({ mappings: result });
  } catch (error) {
    console.error("Error in getUserDepartmentMappings:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ========== GROUPED DOCUMENTS BY STATISTIC ==========
exports.getGroupedDocumentsByStatistic = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;

    const statisticExists = await DeptStatistic.findOne({
      where: { dept_id, statistic_id, is_active: true },
    });

    if (!statisticExists)
      return res.json({ documents: [], correspondences: [] });

    const [docs, corrs, issues] = await Promise.all([
      EntityDocs.findAll({
        where: {
          dept_id,
          statistic_id,
          entity_id,
          is_active: true,
        },
      }),
      EntityCorrespondence.findAll({
        where: {
          dept_id,
          statistic_id,
          entity_id,
          is_active: true,
        },
      }),
      EntityIssues.findAll({
        where: {
          dept_id,
          statistic_id,
          entity_id,
          is_active: true,
        },
      }),
    ]);

    // Also include Tariff Petitions (if present) so UI can show them under 'tp' doc_type
    let tariffDocs = [];
    try {
      const { TariffPetition } = require('../models').models;
      tariffDocs = await TariffPetition.findAll({ where: { dept_id, statistic_id, entity_id, is_active: true } });
      // map into same shape as EntityDocs so front-end can treat them uniformly
        const mapped = (Array.isArray(tariffDocs) ? tariffDocs : []).map(td => ({
        doc_id: td.id,
        doc_name: td.document_name || td.original_name || '',
        doc_path: td.storage_path || null,
        doc_date: td.doc_date || td.createdAt || null,
        createdAt: td.createdAt,
        doc_type: 'tp',
        statistic_id: td.statistic_id,
        entity_id: td.entity_id,
        dept_id: td.dept_id,
      }));

      // merge mapped tariff docs into docs array
      docs.push(...mapped);
    } catch (e) {
      console.warn('Failed to fetch tariff petitions for grouped documents', e.message || e);
    }

    res.json({
      documents: docs,
      correspondences: corrs,
      issues: issues,
    });
  } catch (err) {
    console.error("Error in getGroupedDocumentsByStatistic:", err);
    res.status(500).json({ error: "Failed to fetch grouped documents" });
  }
};

// ========== PMC C&E GROUPED DETAILS ==========
exports.getPmcCEGroupedDetails = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;

    const [statisticExists, entity] = await Promise.all([
      DeptStatistic.findOne({
        where: { dept_id, statistic_id, is_active: true },
      }),
      DeptEntity.findOne({
        where: { dept_id, statistic_id, entity_id, is_active: true },
      }),
    ]);

    if (!statisticExists || !entity) {
      return res.json({
        documents: [],
        correspondences: [],
        issues: [],
        milestones: [],
      });
    }

    const [docs, corrs, issues, pmcEntries] = await Promise.all([
      EntityDocs.findAll({
        where: {
          dept_id,
          statistic_id,
          entity_id,
          is_active: true,
        },
      }),
      EntityCorrespondence.findAll({
        where: {
          dept_id,
          statistic_id,
          entity_id,
          is_active: true,
        },
      }),
      EntityIssues.findAll({
        where: {
          dept_id,
          statistic_id,
          entity_id,
          is_active: true,
        },
      }),
      PmcProject.findAll({
        include: [
          {
            model: PmcMilestone,
            as: "milestones",
            separate: true,
            order: [["sr_no", "ASC"]],
          },
        ],
        order: [["sno", "ASC"]],
      }),
    ]);

    const entityNameLower = String(entity.entity_name || "")
      .trim()
      .toLowerCase();

    const milestones = pmcEntries
      .filter((entry) => {
        if (!entityNameLower) return true;

        const projectDetails = String(entry.project_details || "").toLowerCase();
        const client = String(entry.client || "").toLowerCase();
        const serviceType = String(entry.service_type || "").toLowerCase();

        return (
          projectDetails.includes(entityNameLower) ||
          client.includes(entityNameLower) ||
          serviceType.includes(entityNameLower)
        );
      })
      .flatMap((entry) => {
        const entryMilestones = Array.isArray(entry.milestones)
          ? entry.milestones
          : [];
        return entryMilestones.map((milestone) => ({
          ...milestone.toJSON(),
          pmc_sno: entry.sno,
        }));
      });

    return res.json({
      documents: docs,
      correspondences: corrs,
      issues: issues,
      milestones,
    });
  } catch (err) {
    console.error("Error in getPmcCEGroupedDetails:", err);
    return res.status(500).json({ error: "Failed to fetch PMC C&E details" });
  }
};

// ========== PMC C&E: Documents (new dedicated endpoints) ==========
exports.createPmcCeDocument = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, doc_name, doc_type, doc_date, doc_path } = req.body;

    if (!dept_id || !statistic_id || !entity_id) {
      return res.status(400).json({ error: "Missing dept_id/statistic_id/entity_id" });
    }

    const doc = await PmcCeDocument.create({
      dept_id,
      statistic_id,
      entity_id,
      doc_name: doc_name || null,
      doc_type: doc_type || "cdoc",
      doc_path: doc_path || null,
      doc_date: doc_date || new Date(),
    });

    return res.status(201).json(doc);
  } catch (err) {
    console.error("createPmcCeDocument error:", err);
    return res.status(500).json({ error: "Failed to create PMC C&E document", detail: err.message });
  }
};

exports.getPmcCeDocuments = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;

    const docs = await PmcCeDocument.findAll({
      where: { dept_id, statistic_id, entity_id, is_active: true },
      order: [["createdAt", "DESC"]],
    });

    return res.json(docs);
  } catch (err) {
    console.error("getPmcCeDocuments error:", err);
    return res.status(500).json({ error: "Failed to fetch documents" });
  }
};

exports.deletePmcCeDocument = async (req, res) => {
  try {
    const { pmc_ce_doc_id } = req.params;
    await PmcCeDocument.update({ is_active: false }, { where: { pmc_ce_doc_id } });
    return res.json({ message: "Document deleted" });
  } catch (err) {
    console.error("deletePmcCeDocument error:", err);
    return res.status(500).json({ error: "Failed to delete document" });
  }
};

// ========== PMC C&E: Correspondences ==========
exports.createPmcCeCorrespondence = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, subject, sender, recipient, correspondence_date, correspondence_type, doc_path } = req.body;

    if (!dept_id || !statistic_id || !entity_id) {
      return res.status(400).json({ error: "Missing dept_id/statistic_id/entity_id" });
    }

    const corr = await PmcCeCorrespondence.create({
      dept_id,
      statistic_id,
      entity_id,
      subject: subject || null,
      sender: sender || null,
      recipient: recipient || null,
      correspondence_date: correspondence_date || new Date(),
      correspondence_type: correspondence_type || "contractor",
      doc_path: doc_path || null,
    });

    return res.status(201).json(corr);
  } catch (err) {
    console.error("createPmcCeCorrespondence error:", err);
    return res.status(500).json({ error: "Failed to create correspondence", detail: err.message });
  }
};

exports.getPmcCeCorrespondences = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;

    const items = await PmcCeCorrespondence.findAll({
      where: { dept_id, statistic_id, entity_id, is_active: true },
      order: [["createdAt", "DESC"]],
    });

    return res.json(items);
  } catch (err) {
    console.error("getPmcCeCorrespondences error:", err);
    return res.status(500).json({ error: "Failed to fetch correspondences" });
  }
};

exports.deletePmcCeCorrespondence = async (req, res) => {
  try {
    const { pmc_ce_corr_id } = req.params;
    await PmcCeCorrespondence.update({ is_active: false }, { where: { pmc_ce_corr_id } });
    return res.json({ message: "Correspondence deleted" });
  } catch (err) {
    console.error("deletePmcCeCorrespondence error:", err);
    return res.status(500).json({ error: "Failed to delete correspondence" });
  }
};

// ========== ISSUES ==========
exports.deleteIssue = async (req, res) => {
  try {
    const { issue_id } = req.params;
    const issue = await EntityIssues.findOne({ where: { issue_id } });
    if (!issue) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const accessLevel = await resolveUserDeptAccessLevel(req.user, issue.dept_id);
    if (accessLevel !== 'edit' && accessLevel !== 'head') {
      return res.status(403).json({ error: 'Access denied: edit not allowed' });
    }

    await EntityIssues.update(
      { is_active: false },
      { where: { issue_id } },
    );
    res.json({ message: "Issue deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to issue" });
  }
};

// ========== DEPARTMENTS ==========
exports.createDepartment = async (req, res) => {
  try {
    const { dept_name } = req.body;

    // Validate required field
    if (!dept_name) {
      return res.status(400).json({ error: "Department name is required" });
    }

    const newDepartment = await DeptMaster.create({
      dept_name,
      // Other fields use default values from the model definition
    });

    return res.status(201).json({
      message: "Department created successfully",
      department: newDepartment,
    });
  } catch (error) {
    console.error("Error creating department:", error);
    return res.status(500).json({
      error: "An error occurred while creating the department",
    });
  }
};

exports.manageDepartment = async (req, res) => {
  try {
    const { dept_id } = req.params;
    const { is_active } = req.body;
    await DeptMaster.update({ is_active: is_active }, { where: { dept_id } });
    //log it
    res.json({ message: "Department Status updated" });
  } catch (err) {
    console.error("Error updating department:", err);
    res.status(500).json({ error: "Failed to update department" });
  }
};

exports.editHeadCount = async (req, res) => {
  try {
    const { dept_id } = req.params;
    const { yp_count, regular_count, contractual_count } = req.body;
    await DeptMaster.update(
      {
        yp_count: yp_count,
        regular_count: regular_count,
        contractual_count: contractual_count,
      },
      {
        where: { dept_id },
      },
    );
    res.json({ message: "Edited headcount successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to edit headcount" });
  }
};

exports.getAllDepartments = async (req, res) => {
  try {
    const departments = await DeptMaster.findAll({
      attributes: [
        "dept_id",
        "dept_name",
        "regular_count",
        "yp_count",
        "contractual_count",
        "is_active",
      ],
    });
    res.status(200).json(departments);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch departments" });
  }
};
exports.getDepartmentsForUser = async (req, res) => {
  try {
    const requesterRole = req.user?.role;
    const requesterUserId = req.user?.user_id;
    const requestedUserId = req.params.user_id;

    if (requesterRole !== "admin" && String(requestedUserId) !== String(requesterUserId)) {
      return res.status(403).json({ error: "Access denied: invalid user mapping lookup" });
    }

    if (requesterRole === "admin") {
      const departments = await DeptMaster.findAll({
        where: {
          is_active: true,
        },
        attributes: ["dept_id"],
        order: [["dept_name", "ASC"]],
      });

      return res.json({
        departments: departments.map((item) => ({
          dept_id: item.dept_id,
          can_edit: true,
          access_level: "head",
        })),
      });
    }

    const userDepartmentMappings = await UserEditAccess.findAll({
      where: {
        user_id: requesterUserId,
      },
      attributes: ["dept_id", "can_edit", "access_level"],
    });

    const mappedDeptIds = userDepartmentMappings.map((item) => item.dept_id);
    if (!mappedDeptIds.length) {
      return res.json({ departments: [] });
    }

    const departments = await DeptMaster.findAll({
      where: {
        dept_id: mappedDeptIds,
        is_active: true,
      },
      attributes: ["dept_id"],
      order: [["dept_name", "ASC"]],
    });

    const accessLevelMap = new Map(
      userDepartmentMappings.map((item) => {
        const level = String(item.access_level || "").trim().toLowerCase();
        const accessLevel = (level === "view" || level === "edit" || level === "head")
          ? level
          : (item.can_edit !== false ? "edit" : "view");
        return [item.dept_id, accessLevel];
      })
    );

    res.json({
      departments: departments.map((item) => ({
        dept_id: item.dept_id,
        can_edit: accessLevelMap.get(item.dept_id) === "edit" || accessLevelMap.get(item.dept_id) === "head",
        access_level: accessLevelMap.get(item.dept_id) || "view",
      })),
    });
  } catch (err) {
    console.error("Error fetching departments:", err);
      logger.error("Failed to fetch departments for user", err);   
    res.status(500).json({ error: "Failed to fetch departments for user" });
  }
};

exports.getDepartmentDetails = async (req, res) => {
  try {
    const { dept_id } = req.params;
    const department = await DeptMaster.findOne({
      where: { dept_id: dept_id, is_active: true },
    });

    if (!department) {
      return res.status(404).json({ error: "Department not found" });
    }

    res.status(200).json(department);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch department details" });
  }
};

exports.addDepartment = async (req, res) => {
  try {
    const dept = await DeptMaster.create(req.body);
    res.json(dept);
  } catch (err) {
    res.status(500).json({ error: "Failed to add department" });
  }
};

exports.editDepartment = async (req, res) => {
  try {
    const { dept_id } = req.params;
    await DeptMaster.update(req.body, { where: { dept_id } });
    res.json({ message: "Department updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update department" });
  }
};

exports.deleteDepartment = async (req, res) => {
  try {
    const { dept_id } = req.params;
    await DeptMaster.update({ is_active: false }, { where: { dept_id } });
    res.json({ message: "Department deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete department" });
  }
};

// ========== STATISTICS ==========

//toggle showing statistics in the home screen
exports.setHomeStatistic = async (req, res) => {
  try {
    const { dept_id, statistic_id } = req.params;

    // Step 1: Reset all statistics for the department
    await DeptStatistic.update(
      { is_shown_on_home: false },
      { where: { dept_id } },
    );

    // Step 2: Set the selected statistic to true
    await DeptStatistic.update(
      { is_shown_on_home: true },
      { where: { dept_id, statistic_id } },
    );

    res.json({ success: true, message: "Home statistic updated." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.getAllStatistics = async (req, res) => {
  //get all statistics for a specific department
  try {
    const { dept_id } = req.params;
    const statistics = await DeptStatistic.findAll({
      where: { dept_id: dept_id, is_active: true },
    });
    res.status(200).json(statistics);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch statistics" });
  }
};

exports.addStatistic = async (req, res) => {
  try {
    const stat = await DeptStatistic.create(req.body);
    res.json(stat);
  } catch (err) {
    res.status(500).json({ error: "Failed to add statistic" });
  }
};

exports.editStatistic = async (req, res) => {
  try {
    const { dept_id, statistic_id } = req.params;
    await DeptStatistic.update(req.body, { where: { dept_id, statistic_id } });
    res.json({ message: "Statistic updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update statistic" });
  }
};

exports.deleteStatistic = async (req, res) => {
  try {
    const { dept_id, statistic_id } = req.params;
    await DeptStatistic.update(
      { is_active: false },
      {
        where: { dept_id, statistic_id },
      },
    );
    res.json({ message: "Statistic deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete statistic" });
  }
};

// ========== ENTITIES ==========

exports.getAllEntities = async (req, res) => {
  try {
    const { dept_id, statistic_id } = req.params;
    const entities = await DeptEntity.findAll({
      where: { dept_id: dept_id, statistic_id: statistic_id, is_active: true },
    });
    res.status(200).json(entities);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch entities" });
  }
};

// Resolve dept_id and statistic_id using only entity_id
exports.getEntityContextById = async (req, res) => {
  try {
    // The incoming id may be an actual DeptEntity.entity_id OR it may be
    // a pmc_entry_id (from pmc_project / pmc_slice_meta). Try several
    // fallbacks so client code can pass either identifier.
    const rawId = req.params.entity_id;
    if (!rawId) return res.status(400).json({ error: 'entity_id is required' });

    // 1) Try to resolve as DeptEntity.entity_id first
    let entity = await DeptEntity.findOne({ where: { entity_id: rawId } });
    if (entity) {
      return res.json({ dept_id: entity.dept_id, statistic_id: entity.statistic_id, entity_id: entity.entity_id });
    }

    // 2) If not found, try to resolve as a pmc_entry_id on PmcProject
    // or on PmcSliceMeta and then match by project_name to an entity
    try {
      // prefer PmcProject lookup
      let project = null;
      if (typeof PmcProject !== 'undefined') {
        project = await PmcProject.findOne({ where: { pmc_entry_id: rawId } });
      }
      // fallback to slice meta lookup
      if (!project && typeof PmcSliceMeta !== 'undefined') {
        const slice = await PmcSliceMeta.findOne({ where: { pmc_entry_id: rawId } });
        if (slice) project = { project_name: slice.project_name };
      }

      if (project && project.project_name) {
        // try to find a DeptEntity with matching name (best-effort)
        const byName = await DeptEntity.findOne({ where: { entity_name: project.project_name } });
        if (byName) {
          return res.json({ dept_id: byName.dept_id, statistic_id: byName.statistic_id, entity_id: byName.entity_id });
        }

        // If we couldn't find a DeptEntity but we resolved a PMC entry/slice
        // return a lightweight context containing the original id so callers
        // can still open project-scoped pages. This avoids a hard failure in
        // front-end flows that expect a 200 response and can handle an
        // entity_id that maps to a PMC entry instead of a DeptEntity.
        return res.json({ entity_id: rawId, project_name: project.project_name });
      }
    } catch (e) {
      console.warn('entity context fallback lookup error:', e && e.message);
    }

    return res.status(404).json({ error: 'Entity not found' });
  } catch (err) {
    console.error('getEntityContextById error:', err);
    return res.status(500).json({ error: 'Failed to resolve entity context', detail: err.message });
  }
};

// Get persisted tariff values (requested/approved) for a specific context
exports.getTariffValues = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;
    if (!dept_id || !statistic_id || !entity_id) return res.status(400).json({ error: 'Missing context identifiers' });
    const { TariffContextValue } = require('../models').models;
    const rec = await TariffContextValue.findOne({ where: { dept_id, statistic_id, entity_id } });
    if (!rec) return res.json({ requested_tariff: '', approved_tariff: '' });
    return res.json({ requested_tariff: rec.requested_tariff || '', approved_tariff: rec.approved_tariff || '' });
  } catch (err) {
    console.error('getTariffValues error:', err && err.message);
    return res.status(500).json({ error: 'Failed to fetch tariff values', detail: err && err.message });
  }
};

// Save or update tariff values for a context
exports.saveTariffValues = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, requested_tariff, approved_tariff } = req.body || {};
    if (!dept_id || !statistic_id || !entity_id) return res.status(400).json({ error: 'Missing context identifiers' });
    const { TariffContextValue } = require('../models').models;
    const where = { dept_id, statistic_id, entity_id };
    const existing = await TariffContextValue.findOne({ where });
    if (existing) {
      await TariffContextValue.update({ requested_tariff: requested_tariff || null, approved_tariff: approved_tariff || null }, { where });
      return res.json({ message: 'updated' });
    }
    const created = await TariffContextValue.create({ dept_id, statistic_id, entity_id, requested_tariff: requested_tariff || null, approved_tariff: approved_tariff || null });
    return res.status(201).json(created);
  } catch (err) {
    console.error('saveTariffValues error:', err && err.message);
    return res.status(500).json({ error: 'Failed to save tariff values', detail: err && err.message });
  }
};

exports.addEntity = async (req, res) => {
  try {
    const entity = await DeptEntity.create(req.body);
    res.json(entity);
  } catch (err) {
    res.status(500).json({ error: "Failed to add entity" });
  }
};

exports.editEntity = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;
    await DeptEntity.update(req.body, {
      where: { dept_id, statistic_id, entity_id },
    });
    res.json({ message: "Entity updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update entity" });
  }
};

exports.deleteEntity = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;
    await DeptEntity.update(
      { is_active: false },
      {
        where: { dept_id, statistic_id, entity_id },
      },
    );
    res.json({ message: "Entity deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete entity" });
  }
};

// ========== DOCUMENTS ==========

exports.getAllDocuments = async (req, res) => {
  try {
    const { dept_id, statistic_id } = req.params;
    const documents = await EntityDocs.findAll({
      where: { dept_id, statistic_id },
    });
    res.status(200).json(documents);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch documents" });
  }
};

exports.getContractDocuments = async (req, res) => {
  try {
    const { dept_id } = req.params;

    // 1. Get active statistics for dept_id
    const statistics = await DeptStatistic.findAll({
      where: { dept_id, is_active: true },
      attributes: ["statistic_id"],
    });

    const statIds = statistics.map((stat) => stat.statistic_id);
    if (statIds.length === 0) return res.json([]);

    // 3. Fetch all documents in one go
    const docs = await EntityDocs.findAll({
      where: {
        dept_id,
        statistic_id: entities.map((e) => e.statistic_id),
        // Uncomment if needed:
        // is_active: true
      },
    });

    res.json(docs);
  } catch (err) {
    console.error("Error in getContractDocuments:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.editDocument = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, doc_id } = req.params;
    await EntityDoc.update(req.body, {
      where: { dept_id, statistic_id, entity_id, doc_id },
    });
    res.json({ message: "Document updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update document" });
  }
};

exports.deleteDocument = async (req, res) => {
  try {
    const { doc_id } = req.params;
    const entityDoc = await EntityDocs.findOne({ where: { doc_id } });
    if (entityDoc) {
      const accessLevel = await resolveUserDeptAccessLevel(req.user, entityDoc.dept_id);
      if (accessLevel !== 'edit' && accessLevel !== 'head') {
        return res.status(403).json({ error: 'Access denied: edit not allowed' });
      }

      await EntityDocs.update(
        { is_active: false },
        { where: { doc_id } },
      );
      return res.json({ message: "Document deleted" });
    }

    // If no EntityDocs row was updated, this might be a TariffPetition record.
    try {
      const { TariffPetition } = require('../models').models;
      if (TariffPetition) {
        const tariffDoc = await TariffPetition.findOne({ where: { id: doc_id } });
        if (tariffDoc) {
          const accessLevel = await resolveUserDeptAccessLevel(req.user, tariffDoc.dept_id);
          if (accessLevel !== 'edit' && accessLevel !== 'head') {
            return res.status(403).json({ error: 'Access denied: edit not allowed' });
          }

          await TariffPetition.update(
            { is_active: false },
            { where: { id: doc_id } },
          );
          return res.json({ message: 'Tariff petition deleted' });
        }
      }
    } catch (e) {
      // Continue to fallback response
      console.warn('TariffPetition delete check failed:', e && e.message);
    }

    // If nothing matched, respond with not found
    res.status(404).json({ error: 'Document not found' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete document" });
  }
};

// ========== CORRESPONDENCES ==========

exports.getAllCorrespondences = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;
    const correspondences = await EntityCorrespondence.findAll({
      where: {
        dept_id: dept_id,
        statistic_id: statistic_id,
        is_active: true,
      },
    });
    res.status(200).json(correspondences);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch correspondences" });
  }
};

exports.getCorrespondencesForDepartment = async (req, res) => {
  try {
    const { dept_id } = req.params;

    // 1. Find all active statistics for the department
    const statistics = await DeptStatistic.findAll({
      where: { dept_id, is_active: true },
      attributes: ["statistic_id"],
    });

    const statIds = statistics.map((stat) => stat.statistic_id);
    if (statIds.length === 0) return res.json([]);

    // 3. Find all active correspondences for those entities
    const correspondences = await EntityCorrespondence.findAll({
      where: {
        dept_id,
        statistic_id: entities.map((e) => e.statistic_id),

        is_active: true,
      },
    });

    res.json(correspondences);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch correspondences" });
  }
};

exports.editCorrespondence = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, correspondence_id } = req.params;
    await EntityCorrespondence.update(req.body, {
      where: { dept_id, statistic_id, entity_id, correspondence_id },
    });
    res.json({ message: "Correspondence updated" });
  } catch (err) {
    res.status(500).json({ error: "Failed to update correspondence" });
  }
};

exports.deleteCorrespondence = async (req, res) => {
  try {
    const { correspondence_id } = req.params;
    const correspondence = await EntityCorrespondence.findOne({ where: { correspondence_id } });
    if (!correspondence) {
      return res.status(404).json({ error: 'Correspondence not found' });
    }

    const accessLevel = await resolveUserDeptAccessLevel(req.user, correspondence.dept_id);
    if (accessLevel !== 'edit' && accessLevel !== 'head') {
      return res.status(403).json({ error: 'Access denied: edit not allowed' });
    }

    await EntityCorrespondence.update(
      { is_active: false },
      { where: { correspondence_id } },
    );
    res.json({ message: "Correspondence deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete correspondence" });
  }
};

// ========== FIELDS ==========
exports.getFieldsForDepartmentEntityStatistic = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;
    const foundEntityFields = await EntityFields.findAll({
      where: {
        dept_id: dept_id,
        statistic_id: statistic_id,
        entity_id: entity_id,
        is_active: true,
      },
    });
    res.json(foundEntityFields);
  } catch (err) {
    res.status(500).json({ error: "Failed to get entity fields" });
  }
};

//edit an existing statistic along with its entities and fields
// exports.editNewStatisticWithDepartmentEntityFields = async (req, res) => {
//   const { dept_id, statistic_id } = req.params;
//   const { statistic_name, entities } = req.body;

//   if (!Array.isArray(entities)) {
//     return res.status(400).json({ error: "Entities must be an array" });
//   }

//   const transaction = await DeptStatistic.sequelize.transaction();

//   try {
//     // Validate statistic_name
//     if (!statistic_name || !statistic_name.trim()) {
//       await transaction.rollback();
//       return res.status(400).json({ error: "Statistic name is required" });
//     }

//     // Update statistic name
//     await DeptStatistic.update(
//       { statistic_name: statistic_name.trim() },
//       { where: { dept_id, statistic_id }, transaction }
//     );

//     // Fetch all current entities with fields
//     const existingEntities = await DeptEntity.findAll({
//       where: { dept_id, statistic_id, is_active: true },
//       include: [
//         {
//           model: EntityFields,
//           as: "fields",
//           where: { is_active: true },
//           required: false,
//         },
//       ],
//       transaction,
//     });

//     // Collect entity IDs sent from client (to detect deletions)
//     const incomingEntityIds = entities
//       .filter((e) => e.entity_id)
//       .map((e) => e.entity_id);

//     // Soft-delete entities removed by client
//     for (const dbEntity of existingEntities) {
//       if (!incomingEntityIds.includes(dbEntity.entity_id)) {
//         await dbEntity.update({ is_active: false }, { transaction });

//         // Also deactivate related fields
//         await EntityFields.update(
//           { is_active: false },
//           { where: { entity_id: dbEntity.entity_id }, transaction }
//         );
//       }
//     }

//     // Process each incoming entity
//     for (const entity of entities) {
//       // Validate entity fields array
//       if (!Array.isArray(entity.fields)) {
//         await transaction.rollback();
//         return res
//           .status(400)
//           .json({ error: "Each entity must have an array of fields" });
//       }

//       // Validate required entity fields
//       if (!entity.entity_name || typeof entity.entity_value !== "number") {
//         await transaction.rollback();
//         return res.status(400).json({
//           error: "Entity name (string) and numeric entity value are required",
//         });
//       }

//       let entityRecord;

//       if (entity.entity_id) {
//         // Update existing entity
//         entityRecord = await DeptEntity.findOne({
//           where: { dept_id, statistic_id, entity_id: entity.entity_id },
//           transaction,
//         });

//         if (!entityRecord) {
//           await transaction.rollback();
//           return res
//             .status(400)
//             .json({ error: `Entity with id ${entity.entity_id} not found` });
//         }

//         await entityRecord.update(
//           {
//             entity_name: entity.entity_name.trim(),
//             entity_value: entity.entity_value,
//             is_active: true,
//           },
//           { transaction }
//         );
//       } else {
//         // Create new entity or reactivate existing by name
//         const [createdEntity, created] = await DeptEntity.findOrCreate({
//           where: {
//             dept_id,
//             statistic_id,
//             entity_name: entity.entity_name.trim(),
//           },
//           defaults: {
//             entity_value: entity.entity_value,
//             is_active: true,
//           },
//           transaction,
//         });

//         if (!created) {
//           await createdEntity.update(
//             { entity_value: entity.entity_value, is_active: true },
//             { transaction }
//           );
//         }

//         entityRecord = createdEntity;
//       }

//       // Fetch existing active fields for this entity
//       const existingFields = await EntityFields.findAll({
//         where: { entity_id: entityRecord.entity_id, is_active: true },
//         transaction,
//       });

//       const incomingFieldIds = entity.fields
//         .filter((f) => f.field_id)
//         .map((f) => f.field_id);

//       const incomingFieldNames = entity.fields
//         .filter((f) => f.field_name)
//         .map((f) => f.field_name.trim());

//       // Soft-delete fields not included in the incoming payload
//       for (const dbField of existingFields) {
//         const isStillPresent = entity.fields.some(
//           (f) =>
//             (f.field_id && f.field_id === dbField.field_id) ||
//             (f.field_name && f.field_name.trim() === dbField.field_name.trim()),
//         );

//         if (!isStillPresent) {
//           await dbField.update({ is_active: false }, { transaction });
//         }
//       }

//       // Process each field for this entity
//       for (const field of entity.fields) {
//         // Validate required field fields
//         if (!field.field_name || field.field_value === undefined) {
//           await transaction.rollback();
//           return res.status(400).json({
//             error: "Field name and field value are required",
//           });
//         }

//         if (field.field_id) {
//           // Update existing field
//           await EntityFields.update(
//             {
//               field_name: field.field_name.trim(),
//               field_value: field.field_value,
//               field_unit: field.field_unit ? field.field_unit.trim() : "MW",
//               is_active: true,
//             },
//             {
//               where: {
//                 entity_id: entityRecord.entity_id,
//                 field_id: field.field_id,
//               },
//               transaction,
//             }
//           );
//         } else {
//           // Create new field or reactivate existing by name
//           const [createdField, created] = await EntityFields.findOrCreate({
//             where: {
//               entity_id: entityRecord.entity_id,
//               field_name: field.field_name.trim(),
//             },
//             defaults: {
//               dept_id,
//               statistic_id,
//               field_value: field.field_value,
//               field_unit: field.field_unit ? field.field_unit.trim() : "MW",
//               is_active: true,
//             },
//             transaction,
//           });

//           if (!created) {
//             await createdField.update(
//               {
//                 field_value: field.field_value,
//                 field_unit: field.field_unit ? field.field_unit.trim() : "MW",
//                 is_active: true,
//               },
//               { transaction }
//             );
//           }
//         }
//       }
//     }

//     await transaction.commit();

//     return res.status(200).json({
//       message: "Statistic and related entities updated successfully",
//     });
//   } catch (err) {
//     await transaction.rollback();
//     console.error(err);
//     return res.status(500).json({
//       error: "Failed to update statistic with entities and fields",
//       details: err.message,
//     });
//   }
// };

// Edit an existing statistic along with its entities and fields
exports.editNewStatisticWithDepartmentEntityFields = async (req, res) => {
  const { dept_id, statistic_id } = req.params;
  const { statistic_name, entities } = req.body;

  if (!Array.isArray(entities)) {
    return res.status(400).json({ error: "Entities must be an array" });
  }

  const transaction = await DeptStatistic.sequelize.transaction();

  try {
    // Validate statistic_name
    if (!statistic_name || !statistic_name.trim()) {
      await transaction.rollback();
      return res.status(400).json({ error: "Statistic name is required" });
    }

    // Update statistic name
    await DeptStatistic.update(
      { statistic_name: statistic_name.trim() },
      { where: { dept_id, statistic_id }, transaction },
    );

    // Fetch all current entities with fields
    const existingEntities = await DeptEntity.findAll({
      where: { dept_id, statistic_id, is_active: true },
      include: [
        {
          model: EntityFields,
          as: "fields",
          where: { is_active: true },
          required: false,
        },
      ],
      transaction,
    });

    // Collect entity IDs sent from client (to detect deletions)
    const incomingEntityIds = entities
      .filter((e) => e.entity_id)
      .map((e) => e.entity_id);

    // Soft-delete entities removed by client
    for (const dbEntity of existingEntities) {
      if (!incomingEntityIds.includes(dbEntity.entity_id)) {
        await dbEntity.update({ is_active: false }, { transaction });

        // Also deactivate related fields
        await EntityFields.update(
          { is_active: false },
          { where: { entity_id: dbEntity.entity_id }, transaction },
        );
      }
    }

    // Process each incoming entity
    for (const entity of entities) {
      // Validate entity fields array
      if (!Array.isArray(entity.fields)) {
        await transaction.rollback();
        return res
          .status(400)
          .json({ error: "Each entity must have an array of fields" });
      }

      // Validate required entity fields
      if (!entity.entity_name || typeof entity.entity_value !== "number") {
        await transaction.rollback();
        return res.status(400).json({
          error: "Entity name (string) and numeric entity value are required",
        });
      }

      let entityRecord;

      if (entity.entity_id) {
        // Update existing entity
        entityRecord = await DeptEntity.findOne({
          where: { dept_id, statistic_id, entity_id: entity.entity_id },
          transaction,
        });

        if (!entityRecord) {
          await transaction.rollback();
          return res
            .status(400)
            .json({ error: `Entity with id ${entity.entity_id} not found` });
        }

        await entityRecord.update(
          {
            entity_name: entity.entity_name.trim(),
            entity_value: entity.entity_value,
            is_active: true,
          },
          { transaction },
        );
      } else {
        // Create new entity or reactivate existing by name
        const [createdEntity, created] = await DeptEntity.findOrCreate({
          where: {
            dept_id,
            statistic_id,
            entity_name: entity.entity_name.trim(),
          },
          defaults: {
            entity_value: entity.entity_value,
            is_active: true,
          },
          transaction,
        });

        if (!created) {
          await createdEntity.update(
            { entity_value: entity.entity_value, is_active: true },
            { transaction },
          );
        }

        entityRecord = createdEntity;
      }

      // Fetch existing active fields for this entity
      const existingFields = await EntityFields.findAll({
        where: { entity_id: entityRecord.entity_id, is_active: true },
        transaction,
      });

      const incomingFieldIds = entity.fields
        .filter((f) => f.field_id)
        .map((f) => f.field_id);

      const incomingFieldNames = entity.fields
        .filter((f) => f.field_name)
        .map((f) => f.field_name.trim());

      // Soft-delete fields not included in the incoming payload
      for (const dbField of existingFields) {
        const isStillPresent = entity.fields.some(
          (f) =>
            (f.field_id && f.field_id === dbField.field_id) ||
            (f.field_name && f.field_name.trim() === dbField.field_name.trim()),
        );

        if (!isStillPresent) {
          await dbField.update({ is_active: false }, { transaction });
        }
      }

      // Process each field for this entity
      for (const field of entity.fields) {
        // Validate required field fields
        if (!field.field_name || field.field_value === undefined) {
          await transaction.rollback();
          return res.status(400).json({
            error: "Field name and field value are required",
          });
        }

        if (field.field_id) {
          // Update existing field
          await EntityFields.update(
            {
              field_name: field.field_name.trim(),
              field_value: field.field_value,
              field_unit: field.field_unit ? field.field_unit.trim() : "MW",
              is_active: true,
            },
            {
              where: {
                entity_id: entityRecord.entity_id,
                field_id: field.field_id,
              },
              transaction,
            },
          );
        } else {
          // Create new field or reactivate existing by name
          const [createdField, created] = await EntityFields.findOrCreate({
            where: {
              entity_id: entityRecord.entity_id,
              field_name: field.field_name.trim(),
            },
            defaults: {
              dept_id,
              statistic_id,
              field_value: field.field_value,
              field_unit: field.field_unit ? field.field_unit.trim() : "MW",
              is_active: true,
            },
            transaction,
          });

          if (!created) {
            await createdField.update(
              {
                field_value: field.field_value,
                field_unit: field.field_unit ? field.field_unit.trim() : "MW",
                is_active: true,
              },
              { transaction },
            );
          }
        }
      }
    }

    await transaction.commit();

     return res.status(200).json({
      message: "Statistic and related entities updated successfully",
    });
  } catch (err) {
    await transaction.rollback();
    console.error(err);
    return res.status(500).json({
      error: "Failed to update statistic with entities and fields",
      details: err.message,
    });
  }
};


//create a new statistic with entities and fields
exports.createNewStatisticWithDepartmentEntityFields = async (req, res) => {
  try {
    const { dept_id, user_id } = req.params;
    const { statistic_name, entities } = req.body;
    //first create the statistic with this name
    await DeptStatistic.create({
      statistic_name: statistic_name,
      dept_id: dept_id,
    }).then((createdStatistic) => {
      //then create the entities for the statistic
      entities.forEach(async (entity) => {
        await DeptEntity.create({
          dept_id: dept_id,
          statistic_id: createdStatistic.statistic_id,
          entity_name: entity.entity_name,
          entity_value: entity.entity_value,
        }).then(async (createdEntity) => {
          entity.fields.forEach(async (field) => {
            await EntityFields.create({
              dept_id: dept_id,
              statistic_id: createdStatistic.statistic_id,
              entity_id: createdEntity.entity_id,
              field_name: field.field_name,
              field_value: field.field_value,
              field_unit: field.field_unit,
            });
          });
        });
      });
    });

    res.json({ message: "Statistic added successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add statistic" });
  }
};

// Routes related to contracts table

exports.createEntryInContractsTable = async (req, res) => {
  try {
    /** Creates an entry in the contracts table */
    const createdEntry = await ContractsTable.create(req.body);
    res.status(201).json({
      message: "entry created successfully",
      data: createdEntry,
    });
  } catch (err) {
    console.error("Error creating contract:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.getEntriesFromContractsTable = async (req, res) => {
  try {
    const activeContracts = await ContractsTable.findAll({
      where: { is_active: true },
    });

    res.status(200).json({
      message: "Active contracts fetched successfully",
      data: activeContracts,
    });
  } catch (err) {
    console.error("Error fetching active contracts:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.deleteEntryFromContractsTable = async (req, res) => {
  const { entry_id } = req.params;

  try {
    const deletedCount = await ContractsTable.destroy({
      where: { entry_id },
    });

    if (deletedCount === 0) {
      return res.status(404).json({ error: "Contract not found" });
    }

    res.status(200).json({
      message: "Contract deleted successfully",
    });
  } catch (err) {
    console.error("Error deleting contract:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

function parseTenderValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const cleaned = String(value).replace(/,/g, "").trim();
  const num = Number(cleaned);
  return Number.isNaN(num) ? null : num;
}

const CANONICAL_TECHNOLOGIES = ["Solar", "Wind", "Hybrid", "RTC", "FDRE"];

function normalizeTechnologyType(value) {
  const tech = String(value || "").trim().toLowerCase();
  if (!tech) return null;
  if (tech.includes("solar")) return "Solar";
  if (tech.includes("wind")) return "Wind";
  if (tech.includes("hybrid")) return "Hybrid";
  if (tech.includes("rtc")) return "RTC";
  if (tech.includes("fdre")) return "FDRE";
  return null;
}

function isValidTenderRow(row, mapped) {
  const normalizedTech = normalizeTechnologyType(mapped?.technology_type || row?.technology_type);
  if (!normalizedTech || !CANONICAL_TECHNOLOGIES.includes(normalizedTech)) {
    return false;
  }

  // Accept rows that have at least one positive numeric value in any key field.
  // This matches the business rule: exclude rows that are completely empty/invalid,
  // but keep rows that have data in any field (ERA, PPA, PSA, Commissioned, Tariff).
  const capacity = parseTenderValue(mapped?.tendered_capacity_mw ?? row?.tendered_capacity_mw);
  const era = parseTenderValue(mapped?.era_awarded_capacity_mw ?? row?.era_awarded_capacity_mw);
  const ppa = parseTenderValue(mapped?.ppa_capacity_mw ?? row?.ppa_capacity_mw);
  const psa = parseTenderValue(mapped?.psa_capacity_mw ?? row?.psa_capacity_mw);
  const commissioned = parseTenderValue(mapped?.commissioned_capacity_mw ?? row?.commissioned_capacity_mw);
  const tariff = parseTenderValue(mapped?.tariff ?? row?.tariff);

  const hasAnyPositiveValue = [capacity, era, ppa, psa, commissioned, tariff]
    .some(v => typeof v === "number" && v > 0);

  if (!hasAnyPositiveValue) {
    return false;
  }

  return true;
}

function buildTenderLookupWhere(tender) {
  if (!tender) return {};

  if (tender.rfs_number) {
    return { rfs_number: tender.rfs_number };
  }

  const where = {};
  if (tender.tender_title) {
    where.tender_title = tender.tender_title;
  }
  if (tender.year != null) {
    where.year = tender.year;
  }
  if (tender.technology_type) {
    where.technology_type = tender.technology_type;
  }
  if (tender.tendering_agency) {
    where.tendering_agency = tender.tendering_agency;
  }
  if (tender.stage) {
    where.stage = tender.stage;
  }
  return where;
}

exports.buildTenderLookupWhere = buildTenderLookupWhere;

/**
 * Build a normalized column name mapping from row keys.
 * Normalizes by lowercasing, collapsing whitespace, and removing
 * duplicate disambiguation suffixes like "(Col N)".
 * Returns: { normalizedName: [actualKey1, actualKey2, ...] }
 * This is more robust than fuzzy string matching because it:
 * - Preserves meaningful characters like / in "PSA/PPA"
 * - Handles extra whitespace (e.g. "Type of   Technology")
 * - Handles duplicate column suffixes "(Col N)"
 * - Returns ALL matching keys so callers can try each value
 */
function buildColumnMapping(rowKeys) {
  const normMap = {};
  for (const key of rowKeys) {
    const str = String(key || '').trim();
    if (!str) continue;
    // Normalize: lowercase, collapse whitespace, remove (Col N) suffix
    const norm = str.toLowerCase().replace(/\s+/g, ' ').replace(/\(col\s+\d+\)$/i, '').trim();
    if (!norm) continue;
    if (!normMap[norm]) normMap[norm] = [];
    // Store actual key (not normalized) for looking up in row objects
    normMap[norm].push(str);
  }
  return normMap;
}

function mapTenderRow(row, normMap) {
  // Helper: get first non-empty value by trying multiple normalized column names.
  // Tries each normalized name, then each actual column key within that name.
  function getValue(...normalizedNames) {
    for (const name of normalizedNames) {
      const keys = normMap[name];
      if (!keys) continue;
      for (const key of keys) {
        const val = row[key];
        if (val !== undefined && val !== null && String(val).trim() !== '') {
          return val;
        }
      }
    }
    return undefined;
  }

  // Helper: get parsed positive numeric value, skipping 0 so fallback columns are tried.
  // A cell containing 0 means "no value" for this field — we continue searching other
  // column name variants (e.g. "Commissioning Capacity (MW)" after "Capacity Commissioned (MW)"=0).
  function getNumeric(...normalizedNames) {
    for (const name of normalizedNames) {
      const keys = normMap[name];
      if (!keys) continue;
      for (const key of keys) {
        const val = row[key];
        const parsed = parseTenderValue(val);
        if (parsed !== null && parsed > 0) return parsed;
      }
    }
    return null;
  }

  return {
    tender_title: getValue('tender title', 'name of tender', 'tender') || null,
    tendering_agency: getValue('tendering agency', 'agency') || null,
    developer_name: getValue('project developer name', 'developer name', 'developer') || null,
    technology_type: (function() {
        // Priority: Type of Technology (Tender Details) > Type of Technology LOA (LOA/LOI) > Technology Type > Technology/Tech
        // Previously both columns were named "Type of Technology" so the same
        // normalized key handled both. Now the LOA/LOI column is renamed to
        // "Type of Technology LOA", requiring a separate fallback.
        let v = getValue('type of technology');
        if (v && String(v).trim()) return String(v).trim();
        v = getValue('type of technology loa');
        if (v && String(v).trim()) return String(v).trim();
        v = getValue('technology type');
        if (v && String(v).trim()) return String(v).trim();
        v = getValue('technology', 'tech');
        if (v && String(v).trim()) return String(v).trim();
        return null;
      })(),
    mode: getValue('mode', 'mode of tender') || null,
    year: (function() {
        const yearVal = getNumeric('year', 'fy');
        if (yearVal !== null && yearVal >= 1900 && yearVal <= 2100) return yearVal;
        // Extract year from date columns
        const dateVal = getValue('date of issue of rfs', 'rfs date', 'rfs issue date', 'date of issue of nit', 'date of issue of loa');
        if (dateVal) {
          const ds = String(dateVal).trim();
          let m = ds.match(/(\d{4})[-/]\d{2}[-/]\d{2}/);
          if (m) return Number(m[1]);
          m = ds.match(/(\d{2})[-/](\d{2})[-/](\d{4})/);
          if (m) return Number(m[3]);
        }
        return null;
      })(),
    rfs_number: getValue('rfs number', 'rfs', 'rfs no', 'nit number', 'nit', 'nit no') || null,
    rfs_date: getValue('date of issue of rfs', 'rfs date', 'rfs issue date', 'date of issue of nit', 'date of issue of loa') || null,
    tariff: getNumeric('tariff (rs/kwhr) loa', 'tariff (rs/kwhr)', 'tariff (rs)', 'tariff') || null,
    tendered_capacity_mw: getNumeric('tendered capacity (mw)', 'tendered capacity', 'capacity (mw)', 'capacity') || null,
    era_awarded_capacity_mw: getNumeric('capacity awarded by era (mw)', 'capacity awarded by era', 'era awarded capacity (mw)', 'era awarded capacity') || null,
    loa_loi_capacity_mw: getNumeric('loa/loi capacity', 'loa capacity (mw)', 'loa capacity', 'loi capacity (mw)', 'loi capacity', 'awarded capacity (mw)', 'awarded capacity') || null,
    commissioned_capacity_mw: getNumeric('capacity commissioned (mw)', 'capacity commissioned', 'commissioned capacity (mw)', 'commissioned capacity', 'commissioned', 'commissioned capacity signed (mw)', 'commissioned signed') || null,
    psa_capacity_mw: getNumeric('psa capacity (mw)', 'psa capacity', 'psa', 'psa signed capacity (mw)', 'psa signed (mw)', 'psa signed', 'psa capacity signed (mw)') || null,
    ppa_capacity_mw: getNumeric('ppa capacity (mw)', 'ppa capacity', 'ppa', 'ppa signed capacity (mw)', 'ppa signed (mw)', 'ppa signed', 'ppa capacity signed (mw)') || null,
    psa_ppa_capacity_mw: getNumeric('psa/ppa signed (mw)', 'psa/ppa signed', 'ppa/psa signed (mw)', 'ppa/psa signed') || null,
    storage_capacity_mw: getNumeric('storage capacity (mw)', 'storage capacity') || null,
    stage: getValue('status of connectivity', 'tender stage', 'stage', 'status') || null,
  };
}

/**
 * Helper: return the parsed numeric value if it is a positive number, else 0.
 * Used for per-KPI inclusion — a row contributes to a KPI only if that field > 0.
 */
function positiveValue(value) {
  const n = parseTenderValue(value);
  return (typeof n === "number" && n > 0) ? n : 0;
}

function summarizeTenderRows(rows) {
  const techMap = {};
  const stageMap = {};
  const yearMap = {};

  // Unique tender tracking — use rfs_number first, fall back to tender_title
  const globalTenderKeys = new Set();
  const techTenderKeys = {};
  const yearTenderKeys = {};
  const stageTenderKeys = {};

  let totalTendered = 0;
  let totalEraAwarded = 0;
  let totalLoaLoi = 0;
  let totalCommissioned = 0;
  let totalPsa = 0;
  let totalPpa = 0;

  for (const row of rows) {
    // ── Count ALL rows regardless of technology for these KPIs ───
    totalCommissioned += positiveValue(row.commissioned_capacity_mw);
    totalPsa += positiveValue(row.psa_capacity_mw);
    totalPpa += positiveValue(row.ppa_capacity_mw);

    // Base validation: only include rows with a recognized technology
    // for other KPIs (tendered, ERA, tariff, year breakdowns, etc.)
    const tech = normalizeTechnologyType(row.technology_type);
    if (!tech || !CANONICAL_TECHNOLOGIES.includes(tech)) continue;

    const tenderKey = String(row.rfs_number || row.tender_title || "").trim();
    if (tenderKey) {
      globalTenderKeys.add(tenderKey);
      if (!techTenderKeys[tech]) techTenderKeys[tech] = new Set();
      techTenderKeys[tech].add(tenderKey);
    }

    const stage = row.stage || "Unknown";
    const year = String(row.year || "Unknown").trim();

    // ── Per-KPI inclusion ──────────────────────────────────────
    // Each field contributes to its KPI only when its value is positive (> 0).
    const tc = positiveValue(row.tendered_capacity_mw);
    const ec = positiveValue(row.era_awarded_capacity_mw);
    const lc = positiveValue(row.loa_loi_capacity_mw);
    const cc = positiveValue(row.commissioned_capacity_mw);
    const psc = positiveValue(row.psa_capacity_mw);
    const ppc = positiveValue(row.ppa_capacity_mw);

    totalTendered += tc;
    totalEraAwarded += ec;
    totalLoaLoi += lc;

    // ── Technology breakdown ───────────────────────────────────
    if (!techMap[tech]) {
      techMap[tech] = { capacity: 0, era_capacity: 0, ppa_capacity: 0, psa_capacity: 0, commissioned_capacity: 0 };
    }
    techMap[tech].capacity += tc;
    techMap[tech].era_capacity += ec;
    techMap[tech].ppa_capacity += ppc;
    techMap[tech].psa_capacity += psc;
    techMap[tech].commissioned_capacity += cc;

    // ── Year breakdown (tendered capacity only) ────────────────
    if (!yearMap[year]) yearMap[year] = { capacity: 0, commissioned_capacity: 0 };
    yearMap[year].capacity += tc;
    yearMap[year].commissioned_capacity += cc;
    if (tenderKey) {
      if (!yearTenderKeys[year]) yearTenderKeys[year] = new Set();
      yearTenderKeys[year].add(tenderKey);
    }

    // ── Stage breakdown (tendered capacity only) ───────────────
    if (!stageMap[stage]) stageMap[stage] = { capacity: 0 };
    stageMap[stage].capacity += tc;
    if (tenderKey) {
      if (!stageTenderKeys[stage]) stageTenderKeys[stage] = new Set();
      stageTenderKeys[stage].add(tenderKey);
    }
  }

  // Build final response with unique-tender counts
  const byTechnology = Object.entries(techMap).map(([technology_type, values]) => {
    const keys = techTenderKeys[technology_type];
    return { technology_type, count: keys ? keys.size : 0, ...values };
  });

  const byYear = Object.entries(yearMap).map(([year, values]) => {
    const keys = yearTenderKeys[year];
    return { year, count: keys ? keys.size : 0, capacity: values.capacity, commissioned_capacity: values.commissioned_capacity };
  });

  const byStage = Object.entries(stageMap).map(([stage, values]) => {
    const keys = stageTenderKeys[stage];
    return { stage, count: keys ? keys.size : 0, capacity: values.capacity };
  });

  return {
    total_tenders: globalTenderKeys.size,
    tendered_capacity_mw: totalTendered,
    era_awarded_capacity_mw: totalEraAwarded,
    loa_loi_capacity_mw: totalLoaLoi,
    commissioned_capacity_mw: totalCommissioned,
    psa_capacity_mw: totalPsa,
    ppa_capacity_mw: totalPpa,
    psa_ppa_capacity_mw: totalPsa + totalPpa,
    by_technology: byTechnology,
    by_stage: byStage,
    by_year: byYear,
  };
}

exports.summarizeTenderRows = summarizeTenderRows;

/**
 * Read rows from a tender register Excel, handling merged/two-row headers.
 * If the first row of data contains sub-header labels (SI. No, etc.), the
 * second row is used as column names and data starts from row 3.
 */
function readTenderExcelRows(filePath) {
  const xlsx = require("xlsx");
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (!raw || raw.length === 0) return [];

  // Detect two-row header: row0 has merged category names, row1 has real column names
  const firstVal = String(raw[0]?.[0] || "").trim();
  const secondVal = String(raw[1]?.[0] || "").trim();
  const headerRowIndex = (/^(si\s*\.?\s*no|sno|sl\s*\.?\s*no|#)$/i.test(secondVal) && /[a-z]/i.test(firstVal))
    ? 1
    : 0;

  const headerRow = raw[headerRowIndex];
  const colCount = headerRow.length;

  // Build column name mapping: use header row values as keys
  // Handle duplicate column names by keeping the first occurrence
  const colMap = {};
  const seenKeys = {};
  for (let i = 0; i < colCount; i++) {
    let key = String(headerRow[i] || "").trim();
    if (key) {
      if (seenKeys[key]) {
        // Append column index to disambiguate duplicates (e.g. two "Storage Capacity (MW)" columns)
        key = key + " (Col " + i + ")";
      }
      seenKeys[key] = true;
    }
    colMap[i] = key;
  }

  // Build data rows
  const result = [];
  for (let r = headerRowIndex + 1; r < raw.length; r++) {
    const rowArr = raw[r];
    // Skip completely empty rows
    const hasVal = rowArr.some((v) => String(v || "").trim() !== "");
    if (!hasVal) continue;

    const rowObj = {};
    for (let i = 0; i < colCount; i++) {
      const key = colMap[i];
      if (key) {
        rowObj[key] = rowArr[i] !== undefined ? rowArr[i] : "";
      }
    }
    result.push(rowObj);
  }

  return result;
}

exports.uploadTenderRegisterExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Excel file is required" });
    }

    const rows = readTenderExcelRows(req.file.path);

    if (!rows.length) {
      return res.status(400).json({ error: "Excel file is empty" });
    }

    const rowKeys = Object.keys(rows[0]);
    // Build a normalized column mapping once, used by mapTenderRow for all rows.
    const normMap = buildColumnMapping(rowKeys);
    const persistedRows = [];
    let inserted = 0;

    // ── Deactivate ALL previously active rows BEFORE processing ──────────
    // This eliminates the overwrite risk: each Excel row becomes its own
    // independent DB row.  No upsert means a developer sub-row can never
    // overwrite a main tender row's values.
    await TenderRegister.update(
      { is_active: false },
      { where: { is_active: true } }
    );

    // ── Process each Excel row → INSERT as a new record ───────────────────
    async function saveTender(tender) {
      if (!tender) return null;
      const payload = {
        tender_title: tender.tender_title,
        tendering_agency: tender.tendering_agency,
        technology_type: tender.technology_type,
        mode: tender.mode,
        year: tender.year,
        rfs_number: tender.rfs_number,
        rfs_date: tender.rfs_date,
        tariff: tender.tariff,
        tendered_capacity_mw: tender.tendered_capacity_mw,
        era_awarded_capacity_mw: tender.era_awarded_capacity_mw,
        loa_loi_capacity_mw: tender.loa_loi_capacity_mw,
        commissioned_capacity_mw: tender.commissioned_capacity_mw,
        psa_capacity_mw: tender.psa_capacity_mw,
        ppa_capacity_mw: tender.ppa_capacity_mw,
        psa_ppa_capacity_mw: (tender.psa_capacity_mw || 0) + (tender.ppa_capacity_mw || 0),
        storage_capacity_mw: tender.storage_capacity_mw,
        stage: tender.stage,
        excel_file_path: req.file.path,
        original_file_name: req.file.originalname,
        uploaded_at: new Date(),
        is_active: true,
      };
      const saved = await TenderRegister.create(payload);
      inserted += 1;
      const json = saved.toJSON();
      persistedRows.push(json);
      return json;
    }

    for (const row of rows) {
      // Skip rows where first cell looks like a sub-header label
      const firstCell = String(row[rowKeys[0]] || "").trim();
      if (/^(si\s*\.?\s*no|sno|sl\s*\.?\s*no|#)$/i.test(firstCell)) continue;

      const mapped = mapTenderRow(row, normMap);
      const normalizedTech = normalizeTechnologyType(mapped.technology_type);
      const normalizedTender = {
        ...mapped,
        technology_type: normalizedTech,
      };

      if (!isValidTenderRow(row, normalizedTender)) {
        // Still insert rows that have commissioned capacity > 0 even if they
        // have no recognized technology. These are developer sub-rows under a
        // main tender — they lack tender-level fields (tech, title, RFS) but
        // contain actual commissioned capacity (col71) that must be counted.
        // CRITICAL: Only insert if commissioned is the ONLY positive field.
        // The Grand Total summary row also has no tech and commissioned > 0,
        // but it contains ALL summary values — inserting it would double-count.
        const hasOtherFields = (normalizedTender.commissioned_capacity_mw > 0) && (
          parseTenderValue(normalizedTender.tendered_capacity_mw) > 0 ||
          parseTenderValue(normalizedTender.era_awarded_capacity_mw) > 0 ||
          parseTenderValue(normalizedTender.loa_loi_capacity_mw) > 0 ||
          parseTenderValue(normalizedTender.psa_capacity_mw) > 0 ||
          parseTenderValue(normalizedTender.ppa_capacity_mw) > 0 ||
          parseTenderValue(normalizedTender.tariff) > 0
        );
        if (hasOtherFields || !normalizedTender.commissioned_capacity_mw || normalizedTender.commissioned_capacity_mw <= 0) continue;
      }

      await saveTender(normalizedTender);
    }

    const summary = summarizeTenderRows(persistedRows);

    return res.status(200).json({
      message: "Tender register uploaded successfully",
      inserted,
      total: persistedRows.length,
      summary,
      rows: persistedRows,
    });
  } catch (err) {
    console.error("Error uploading tender register Excel:", err);
    return res.status(500).json({ error: "Failed to process tender register Excel", detail: err.message });
  }
};

exports.getTenderRegisters = async (req, res) => {
  try {
    const { technology_type, year, stage } = req.query;
    const where = { is_active: true };
    if (technology_type) where.technology_type = technology_type;
    if (year) where.year = Number(year);
    if (stage) where.stage = stage;

    const rows = await TenderRegister.findAll({
      where,
      order: [["year", "DESC"], ["tender_title", "ASC"]],
    });

    return res.status(200).json({ message: "Tender register entries fetched successfully", data: rows });
  } catch (err) {
    console.error("Error fetching tender register entries:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.getTenderRegisterSummary = async (req, res) => {
  try {
    const rows = await TenderRegister.findAll({ where: { is_active: true } });
    const summary = summarizeTenderRows(rows.map((r) => r.toJSON()));
    return res.status(200).json({ message: "Tender register summary fetched successfully", data: summary });
  } catch (err) {
    console.error("Error fetching tender register summary:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.downloadTenderRegisterExcel = async (req, res) => {
  try {
    const row = await TenderRegister.findOne({
      where: { is_active: true },
      order: [["uploaded_at", "DESC"]],
      attributes: ["excel_file_path", "original_file_name"],
    });
    if (!row || !row.excel_file_path) {
      return res.status(404).json({ error: "No uploaded Excel file found" });
    }
    const filePath = row.excel_file_path;
    const fileName = row.original_file_name || "tender_register.xlsx";
    if (require("fs").existsSync(filePath)) {
      return res.download(filePath, fileName);
    } else {
      return res.status(404).json({ error: "Excel file not found on server" });
    }
  } catch (err) {
    console.error("Error downloading tender register Excel:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};

/**
 * Get the most recent tender register upload date.
 * Returns the uploaded_at timestamp of the latest active TenderRegister row.
 */
exports.getTenderRegisterUploadDate = async (req, res) => {
  try {
    const row = await TenderRegister.findOne({
      where: { is_active: true },
      order: [["uploaded_at", "DESC"]],
      attributes: ["uploaded_at"],
    });

    if (!row || !row.uploaded_at) {
      return res.status(404).json({
        error: "No tender register upload found",
      });
    }

    return res.status(200).json({
      message: "Tender register upload date fetched successfully",
      upload_date: row.uploaded_at,
    });
  } catch (err) {
    console.error("Error fetching tender register upload date:", err);
    return res.status(500).json({
      error: "Internal Server Error",
    });
  }
};

/**
 *
 * O&M Controllers
 *
 */
exports.addOMDGR = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.params;
    const {
      date,
      generation,
      error_correction,
      radiation,
      machine_availability,
      grid_availability,
      cumulative_generation,
      is_active,
    } = req.body;

    // Basic validation (optional, can be expanded)
    if (
      date == null ||
      generation == null ||
      error_correction == null ||
      radiation == null ||
      machine_availability == null ||
      grid_availability == null ||
      cumulative_generation == null
    ) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    let parsedDate = new Date(date);

    let cuf_till_date =
      cumulative_generation /
      (grid_availability * 24.0 * 100.0 * parsedDate.getDate());

    const newRecord = await OMDGR.create({
      dept_id,
      statistic_id,
      entity_id,
      date,
      generation,
      error_correction,
      radiation,
      machine_availability,
      grid_availability,
      cumulative_generation,
      cuf_till_date,
      is_active: is_active !== undefined ? is_active : true,
    });

    return res.status(201).json({
      message: "OMDGR record created successfully.",
      data: newRecord,
    });
  } catch (error) {
    console.error("Error in addOMDGR:", error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.getActiveOMDGRs = async (req, res) => {
  try {
    const data = await OMDGR.findAll({
      where: {
        is_active: true,
      },
      order: [["createdAt", "DESC"]], // Optional: latest first
    });

    return res.status(200).json({
      message: "Active OMDGR records retrieved successfully.",
      data,
    });
  } catch (error) {
    console.error("Error fetching active OMDGR records:", error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.getFilteredActiveOMDGRs = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;

    // Build the filter dynamically
    const whereClause = {
      is_active: true,
    };

    if (dept_id) whereClause.dept_id = dept_id;
    if (statistic_id) whereClause.statistic_id = statistic_id;
    if (entity_id) whereClause.entity_id = entity_id;

    const data = await OMDGR.findAll({
      where: whereClause,
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({
      message: "Filtered active OMDGR records retrieved successfully.",
      data,
    });
  } catch (error) {
    console.error("Error fetching filtered active OMDGR records:", error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.deleteOMDGR = async (req, res) => {
  try {
    const { om_dgr_id } = req.params;

    if (!om_dgr_id) {
      return res.status(400).json({ message: "Missing om_dgr_id parameter." });
    }

    // Find the record
    const record = await OMDGR.findOne({ where: { om_dgr_id } });

    if (!record) {
      return res.status(404).json({ message: "OMDGR record not found." });
    }

    // Soft delete: set is_active to false
    record.is_active = false;
    await record.save();

    return res.status(200).json({
      message: "OMDGR record marked as inactive (soft deleted).",
      data: record,
    });
  } catch (error) {
    console.error("Error in deleteOMDGR:", error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.editOMDGR = async (req, res) => {
  try {
    const { om_dgr_id } = req.params;
    const {
      date,
      generation,
      error_correction,
      radiation,
      machine_availability,
      grid_availability,
      cumulative_generation,
      is_active,
    } = req.body;

    // Basic validation (optional, can be expanded)
    if (
      date == null ||
      generation == null ||
      error_correction == null ||
      radiation == null ||
      machine_availability == null ||
      grid_availability == null ||
      cumulative_generation == null
    ) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    // Find the existing record
    const recordToUpdate = await OMDGR.findOne({
      where: {
        om_dgr_id,
      },
    });

    // If the record doesn't exist, return an error
    if (!recordToUpdate) {
      return res.status(404).json({ message: "OMDGR record not found." });
    }

    // Recalculate `cuf_till_date` (you can adjust the logic if needed)
    let parsedDate = new Date(date);
    let cuf_till_date =
      cumulative_generation /
      (grid_availability * 24.0 * 100.0 * parsedDate.getDate());

    // Update the record
    const updatedRecord = await recordToUpdate.update({
      date,
      generation,
      error_correction,
      radiation,
      machine_availability,
      grid_availability,
      cumulative_generation,
      cuf_till_date,
    });

    return res.status(200).json({
      message: "OMDGR record updated successfully.",
      data: updatedRecord,
    });
  } catch (error) {
    console.error("Error in editOMDGR:", error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.getREIAData = async (req, res) => {
  try {
    const foundREIAData = await REIADocuments.findAll();
    const normalized = foundREIAData.map((doc) => {
      const raw = doc && doc.reia_doc_path ? String(doc.reia_doc_path) : "";
      if (!raw) return doc;

      const normalizedPath = raw.replace(/\\/g, "/");
      const lower = normalizedPath.toLowerCase();
      const uploadsIdx = lower.lastIndexOf("/uploads/");

      if (uploadsIdx >= 0) {
        doc.reia_doc_path = normalizedPath.substring(uploadsIdx);
      } else if (lower.startsWith("uploads/")) {
        doc.reia_doc_path = "/" + normalizedPath;
      } else if (lower.startsWith("/uploads/")) {
        doc.reia_doc_path = normalizedPath;
      }

      return doc;
    });
    res.status(200).json({
      data: normalized,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

// returns if the given O&M project is mapped to a project type
exports.checkOMProjectTypeMapping = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;
    const foundProjectMapping = await OMProjectTypeMapping.findOne({
      where: {
        dept_id: dept_id,
        statistic_id: statistic_id,
        entity_id: entity_id,
      },
    });

    const foundEntity = await DeptEntity.findOne({
      where: {
        dept_id: dept_id,
        statistic_id: statistic_id,
        entity_id: entity_id,
      },
    });

    const foundEntityName = foundEntity.entity_name;

    return res.status(200).json({
      message: "Successfully found mappings",
      data: foundProjectMapping,
      entity_name: foundEntityName,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.assignOMProjectMapping = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, om_project_type } = req.query;

    let messageResponse = "Mapping already exists";
    const existingMapping = await OMProjectTypeMapping.findOne({
      where: {
        dept_id: dept_id,
        entity_id: entity_id,
        statistic_id: statistic_id,
      },
    });

    // create the new entry
    if (!existingMapping) {
      await OMProjectTypeMapping.create({
        dept_id: dept_id,
        statistic_id: statistic_id,
        entity_id: entity_id,
        om_project_type: om_project_type,
      });
      messageResponse = "Mapping updated successfully";
    }

    return res.status(200).json({
      message: messageResponse,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal server error.",
      error: error.message,
    });
  }
};

exports.getProjectName = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;
    const foundEntity = await DeptEntity.findOne({
      where: {
        dept_id: dept_id,
        statistic_id: statistic_id,
        entity_id: entity_id,
      },
    });

    return res.status(200).json({
      message: "Found Project Name",
      project_name: foundEntity.entity_name,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getOAllMSolarBESSData = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;
    const foundData = await OMDGRSolarBESS.findAll({
      where: {
        dept_id: dept_id,
        statistic_id: statistic_id,
        entity_id: entity_id,
      },
    });
    return res.status(200).json({
      message: "Found Solar+BESS data",
      data: foundData,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getOMSolarBESSDataForDate = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;
    const { requestedDate } = req.body;

    if (!requestedDate) {
      return res.status(400).json({
        message: "requestedDate is required",
      });
    }

    /* ---------- Date helpers ---------- */
    const shiftDate = (dateStr, days) => {
      const d = new Date(dateStr + "T00:00:00");
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    };

    const last7DaysStart = shiftDate(requestedDate, -7);
    const last7DaysEnd = shiftDate(requestedDate, 0);
    const d = new Date(requestedDate + "T00:00:00");
    d.setFullYear(d.getFullYear() - 1);
    const lastYearSameDate = d.toISOString().slice(0, 10);
    const lastYear7DaysStart = shiftDate(lastYearSameDate, -6);

    /* ---------- Current date ---------- */
    const foundDataForParticularDate = await OMDGRSolarBESS.findOne({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: requestedDate,
      },
    });

    if (!foundDataForParticularDate) {
      return res.status(204).json({
        message: "Data not found for this date",
      });
    }

    /* ---------- Last 7 days (current year) ---------- */
    const last7DaysData = await OMDGRSolarBESS.findAll({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: {
          [Sequelize.Op.between]: [last7DaysStart, last7DaysEnd],
        },
      },
      order: [["date", "ASC"]],
    });

    /* ---------- Last year – same 7-day window ---------- */
    const lastYear7DaysData = await OMDGRSolarBESS.findAll({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: {
          [Sequelize.Op.between]: [lastYear7DaysStart, lastYearSameDate],
        },
      },
      order: [["date", "ASC"]],
    });

    /* ---------- Last year March 31 ---------- */
    const reqDateObj = new Date(requestedDate + "T00:00:00");
    const reqYear = reqDateObj.getFullYear();
    const reqMonth = reqDateObj.getMonth() + 1; // 1-12
    const lastFYEndYear = reqMonth >= 4 ? reqYear : reqYear - 1;
    const lastYearMarch31 = `${lastFYEndYear}-03-31`;

    const lastYearMarch31Data = await OMDGRSolarBESS.findOne({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: lastYearMarch31,
      },
    });

    return res.status(200).json({
      message: "Found data for date",
      data: {
        currentDate: foundDataForParticularDate,
        last7Days: last7DaysData,
        lastYearLast7Days: lastYear7DaysData,
        lastYearMarch31: lastYearMarch31Data,
      },
    });
  } catch (error) {
    console.error("Fetch OM Solar + BESS by date error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Return the most recent date for which OM Solar+BESS data exists for an entity
exports.getOMSolarBESSLatestDate = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;

    if (!dept_id || !statistic_id || !entity_id) {
      return res.status(400).json({ message: "dept_id, statistic_id and entity_id are required" });
    }

    const latest = await OMDGRSolarBESS.findOne({
      where: { dept_id, statistic_id, entity_id },
      order: [["date", "DESC"]],
      attributes: ["date"],
      raw: true,
    });

    if (!latest) {
      return res.status(204).json({ message: "No data found" });
    }

    return res.status(200).json({ date: latest.date });
  } catch (error) {
    console.error("Fetch latest OM Solar+BESS date error:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};


exports.downloadOMSolarBESSExcel = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({
        message: "fromDate and toDate are required",
      });
    }

    const records = await OMDGRSolarBESS.findAll({
      attributes: {
        exclude: [
          "dept_id",
          "statistic_id",
          "entity_id",
          "om_dgr_solar_id",
          "is_active",
          "createdAt",
          "updatedAt",
        ],
      },
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: {
          [Sequelize.Op.between]: [fromDate, toDate],
        },
      },
      order: [["date", "ASC"]],
      raw: true,
    });

    console.log("records ==>", records);

    if (!records.length) {
      return res.status(204).json({
        message: "No data found for given date range",
      });
    }

    await streamExcel({
      res,
      sheetName: "OM Solar + BESS Data",
      fileName: `OM_Solar_BESS_${fromDate}_to_${toDate}.xlsx`,
      data: records,
    });
  } catch (error) {
    console.error("Solar+BESS Excel download error:", error);

    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.updateOMDGRSolarBESSForOneDate = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;

    const {
      date,
      days,
      generation,
      radiation,
      bess_export,
      bess_import,
      plant_availability,
      bess_availability,
      grid_availability,
      peak_power,
      cumulative_generation,
      cumulative_bess_export,
      cumulative_bess_import,
      daily_cuf_worc,
      cuf_till_date,
      remarks,
      is_active,
      action,
    } = req.body;

    console.log("req.body", req.body);

    if (!action || !["add", "update"].includes(action)) {
      return res.status(400).json({
        message: "Invalid or missing action flag (add / update required)",
      });
    }

    const existingRecord = await OMDGRSolarBESS.findOne({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date,
      },
    });

    /* ---------------- ADD ---------------- */
    if (action === "add") {
      if (existingRecord) {
        return res.status(409).json({
          message: "Data already exists for this date. Use update instead.",
        });
      }

      await OMDGRSolarBESS.create({
        dept_id,
        statistic_id,
        entity_id,
        date,
        days,
        generation,
        radiation,
        bess_export,
        bess_import,
        plant_availability,
        bess_availability,
        grid_availability,
        peak_power,
        cumulative_generation,
        cumulative_bess_export,
        cumulative_bess_import,
        daily_cuf_worc,
        cuf_till_date,
        remarks,
        is_active,
      });

      return res.status(201).json({
        message: "OM DGR Solar + BESS data added successfully",
      });
    }

    /* ---------------- UPDATE ---------------- */
    if (action === "update") {
      if (!existingRecord) {
        return res.status(404).json({
          message: "No data found for this date to update",
        });
      }

      await existingRecord.update({
        days,
        generation,
        radiation,
        bess_export,
        bess_import,
        plant_availability,
        bess_availability,
        grid_availability,
        peak_power,
        cumulative_generation,
        cumulative_bess_export,
        cumulative_bess_import,
        daily_cuf_worc,
        cuf_till_date,
        remarks,
        is_active,
      });

      return res.status(200).json({
        message: "OM DGR Solar + BESS data updated successfully",
      });
    }
  } catch (error) {
    console.error("OM DGR Solar + BESS error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getOMSolarDataForDate = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;
    const { requestedDate } = req.body;

    if (!requestedDate) {
      return res.status(400).json({
        message: "requestedDate is required",
      });
    }

    const shiftDate = (dateStr, days) => {
      const d = new Date(dateStr + "T00:00:00");
      d.setDate(d.getDate() + days);
      return d.toISOString().slice(0, 10);
    };

    const last7DaysStart = shiftDate(requestedDate, -7);
    const last7DaysEnd = shiftDate(requestedDate, 0);
    const d = new Date(requestedDate + "T00:00:00");
    d.setFullYear(d.getFullYear() - 1);
    const lastYearSameDate = d.toISOString().slice(0, 10);
    const lastYear7DaysStart = shiftDate(lastYearSameDate, -6);

    const foundDataForParticularDate = await OMDGRSolar.findOne({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: requestedDate,
      },
    });

    if (!foundDataForParticularDate) {
      return res.status(204).json({
        message: "Data not found for this date",
      });
    }

    // 🔹 Last 7 days data (current year)
    const last7DaysData = await OMDGRSolar.findAll({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: {
          [Sequelize.Op.between]: [last7DaysStart, last7DaysEnd],
        },
      },
      order: [["date", "ASC"]],
    });

    // 🔹 Last year – same 7-day range
    const lastYear7DaysData = await OMDGRSolar.findAll({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: {
          [Sequelize.Op.between]: [lastYear7DaysStart, lastYearSameDate],
        },
      },
      order: [["date", "ASC"]],
    });

    const reqDateObj = new Date(requestedDate + "T00:00:00");
    const reqYear = reqDateObj.getFullYear();
    const reqMonth = reqDateObj.getMonth() + 1; // 1-12
    const lastFYEndYear = reqMonth >= 4 ? reqYear : reqYear - 1;
    const lastYearMarch31 = `${lastFYEndYear}-03-31`;

    const lastYearMarch31Data = await OMDGRSolar.findOne({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: lastYearMarch31,
      },
    });

    return res.status(200).json({
      message: "Found data for date",
      data: {
        currentDate: foundDataForParticularDate,
        last7Days: last7DaysData,
        lastYearLast7Days: lastYear7DaysData,
        lastYearMarch31: lastYearMarch31Data,
      },
    });
  } catch (error) {
    console.error("Fetch OM Solar by date error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

// Return the most recent date for which OM Solar data exists for an entity
exports.getOMSolarLatestDate = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;

    if (!dept_id || !statistic_id || !entity_id) {
      return res.status(400).json({ message: "dept_id, statistic_id and entity_id are required" });
    }

    const latest = await OMDGRSolar.findOne({
      where: { dept_id, statistic_id, entity_id },
      order: [["date", "DESC"]],
      attributes: ["date"],
      raw: true,
    });

    if (!latest) {
      return res.status(204).json({ message: "No data found" });
    }

    return res.status(200).json({ date: latest.date });
  } catch (error) {
    console.error("Fetch latest OM Solar date error:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};

exports.downloadOMSolarExcel = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, fromDate, toDate } = req.query;

    if (!fromDate || !toDate) {
      return res.status(400).json({
        message: "fromDate and toDate are required",
      });
    }

    const records = await OMDGRSolar.findAll({
      attributes: {
        exclude: [
          "dept_id",
          "statistic_id",
          "entity_id",
          "om_dgr_solar_id",
          "is_active",
          "createdAt",
          "updatedAt",
        ],
      },
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date: {
          [Sequelize.Op.between]: [fromDate, toDate],
        },
      },
      order: [["date", "ASC"]],
      raw: true,
    });

    console.log("records ==>", records);

    if (!records.length) {
      return res.status(204).json({
        message: "No data found",
      });
    }

    await streamExcel({
      res,
      sheetName: "OM Solar Data",
      fileName: `OM_Solar_${fromDate}_to_${toDate}.xlsx`,
      data: records,
    });
  } catch (error) {
    console.error("Excel download error:", error);
    res.status(500).json({
      message: "Internal server error",
    });
  }
};

exports.updateOMDGRSolarForOneDate = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;

    const {
      date,
      days,
      generation,
      radiation,
      machine_availability,
      grid_availability,
      peak_power,
      cumulative_generation,
      cuf,
      cuf_till_date,
      remarks,
      is_active,
      action,
    } = req.body;

    console.log("req.body", req.body);

    if (!action || !["add", "update"].includes(action)) {
      return res.status(400).json({
        message: "Invalid or missing action flag (add / update required)",
      });
    }

    const existingRecord = await OMDGRSolar.findOne({
      where: {
        dept_id,
        statistic_id,
        entity_id,
        date,
      },
    });

    if (action === "add") {
      if (existingRecord) {
        return res.status(409).json({
          message: "Data already exists for this date. Use update instead.",
        });
      }

      await OMDGRSolar.create({
        dept_id,
        statistic_id,
        entity_id,
        date,
        days,
        generation,
        radiation,
        machine_availability,
        grid_availability,
        peak_power,
        cumulative_generation,
        cuf,
        cuf_till_date,
        remarks,
        is_active,
      });

      return res.status(201).json({
        message: "OM DGR Solar data added successfully",
      });
    }

    if (action === "update") {
      if (!existingRecord) {
        return res.status(404).json({
          message: "No data found for this date to update",
        });
      }

      await existingRecord.update({
        days,
        generation,
        radiation,
        machine_availability,
        grid_availability,
        peak_power,
        cumulative_generation,
        cuf,
        cuf_till_date,
        remarks,
        is_active,
      });

      return res.status(200).json({
        message: "OM DGR Solar data updated successfully",
      });
    }
  } catch (error) {
    console.error("OM DGR Solar error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getProjectCapacity = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;

    const entityCapacity = await DeptEntity.findOne({
      attributes: ["entity_value"],
      where: {
        entity_id: entity_id,
        dept_id: dept_id,
        statistic_id: statistic_id,
      },
      raw: true,
    });

    return res.status(200).json({
      message: "Found capacity for entity_id",
      data: {
        capacity: entityCapacity ? entityCapacity.entity_value : null,
      },
    });
  } catch (error) {
    console.error("Fetch OM Solar by date error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getOMProjectsByDate = async (req, res) => {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ message: "date is required" });
    }

    // 🔹 Calculate financial-year end (31 March) for the selected date
    // If selected month is Apr(4) to Dec(12) -> FY end is same year March 31
    // If selected month is Jan(1) to Mar(3) -> FY end is previous year's March 31
    const inputDate = new Date(date + "T00:00:00");
    const inputYear = inputDate.getFullYear();
    const inputMonth = inputDate.getMonth() + 1; // 1-12
    const fyEndYear = inputMonth >= 4 ? inputYear : inputYear - 1;
    const lastYearMarch31 = `${fyEndYear}-03-31`;

    // 1️⃣ Fetch project mappings
    const projectMappings = await OMProjectTypeMapping.findAll({
      attributes: ["entity_id", "om_project_type"],
      raw: true,
    });

    if (!projectMappings.length) {
      return res.status(404).json({ message: "No project mappings found" });
    }

    // 2️⃣ Fetch entity names
    const entityIds = projectMappings.map((p) => p.entity_id);

    const entities = await DeptEntity.findAll({
      where: {
        entity_id: entityIds,
        is_active: 1,
      },
      attributes: ["entity_id", "entity_name"],
      raw: true,
    });

    const entityNameMap = {};
    entities.forEach((e) => {
      entityNameMap[e.entity_id] = e.entity_name;
    });

    // 3️⃣ Split by project type
    const solarEntityIds = [];
    const solarBessEntityIds = [];

    projectMappings.forEach((p) => {
      if (p.om_project_type === "solar") solarEntityIds.push(p.entity_id);
      if (p.om_project_type === "solar_bess")
        solarBessEntityIds.push(p.entity_id);
    });

    // 4️⃣ Fetch O&M data (selected date + last year March 31)
    const [solarData, solarBessData, solarLastYearData, solarBessLastYearData] =
      await Promise.all([
        solarEntityIds.length
          ? OMDGRSolar.findAll({
              where: { entity_id: solarEntityIds, date, is_active: 1 },
            })
          : [],

        solarBessEntityIds.length
          ? OMDGRSolarBESS.findAll({
              where: { entity_id: solarBessEntityIds, date, is_active: 1 },
            })
          : [],

        solarEntityIds.length
          ? OMDGRSolar.findAll({
              where: {
                entity_id: solarEntityIds,
                date: lastYearMarch31,
                is_active: 1,
              },
            })
          : [],

        solarBessEntityIds.length
          ? OMDGRSolarBESS.findAll({
              where: {
                entity_id: solarBessEntityIds,
                date: lastYearMarch31,
                is_active: 1,
              },
            })
          : [],
      ]);

    // 5️⃣ Attach entity_name
    const attachEntityName = (rows) =>
      rows.map((row) => ({
        ...row.toJSON(),
        entity_name: entityNameMap[row.entity_id] || null,
      }));

    return res.status(200).json({
      message: "OM project data fetched successfully",
      date,
      last_year_march_31: lastYearMarch31,
      data: {
        solar: {
          current: attachEntityName(solarData),
          lastFYYear: attachEntityName(solarLastYearData),
        },
        solar_bess: {
          current: attachEntityName(solarBessData),
          lastFYYear: attachEntityName(solarBessLastYearData),
        },
      },
    });
  } catch (error) {
    console.error("Fetch OM projects by date error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getIssuesAndActionPlan = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id } = req.query;

    const record = await OmProjectTypeIssuesActions.findOne({
      where: {
        dept_id,
        statistic_id,
        entity_id,
      },
      raw: true,
    });

    return res.status(200).json({
      message: "Fetched issues and action plan successfully",
      data: record || null,
    });
  } catch (error) {
    console.error("Fetch issues/action error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.upsertIssuesAndActionPlan = async (req, res) => {
  try {
    const { dept_id, statistic_id, entity_id, key_issues, action_plan } =
      req.body;

    const [record, created] = await OmProjectTypeIssuesActions.upsert({
      dept_id,
      statistic_id,
      entity_id,
      key_issues,
      action_plan,
    });

    return res.status(200).json({
      message: created ? "Created successfully" : "Updated successfully",
      data: record,
    });
  } catch (error) {
    console.error("Upsert issues/action error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getAllIssuesAndActions = async (req, res) => {
  try {

    // 1️⃣ Fetch all issues
    const issues = await OmProjectTypeIssuesActions.findAll({
      attributes: [
        "dept_id",
        "statistic_id",
        "entity_id",
        "key_issues",
        "action_plan",
        "updatedAt",
      ],
      raw: true,
    });

    if (!issues.length) {
      return res.status(404).json({
        message: "No issues found",
      });
    }

    // 2️⃣ Get entity IDs
    const entityIds = issues.map((i) => i.entity_id);

    // 3️⃣ Fetch project names
    const entities = await DeptEntity.findAll({
      where: {
        entity_id: entityIds,
        is_active: 1,
      },
      attributes: ["entity_id", "entity_name"],
      raw: true,
    });

    // 4️⃣ Create map
    const entityNameMap = {};
    entities.forEach((e) => {
      entityNameMap[e.entity_id] = e.entity_name;
    });

    // 5️⃣ Attach project name
    const formatted = issues.map((issue) => ({
      ...issue,
      project_name: entityNameMap[issue.entity_id] || null,
    }));

    return res.status(200).json({
      message: "Fetched all issues successfully",
      count: formatted.length,
      data: formatted,
    });

  } catch (error) {
    console.error("Fetch issues error:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

exports.getAllPmcEntries = async (req, res) => {
  try {
    // The pmc_project table does not have segment/project_name columns; fetch all rows
    // and apply lightweight in-memory filtering based on service_type/client/project_details.
    const segmentParam = (req.query && req.query.segment) ? String(req.query.segment).toLowerCase() : '';
    const projectNameParam = (req.query && req.query.project_name) ? String(req.query.project_name).toLowerCase() : '';

    let entries = await PmcProject.findAll({
      include: [
        {
          model: PmcMilestone,
          as: "milestones",
          separate: true,
          order: [["sr_no", "ASC"]],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    if (segmentParam) {
      const segmentKey = segmentParam.includes('bms')
        ? 'BMS'
        : (segmentParam.includes('exec') ? 'EXECUTION' : 'DPR');
      entries = entries.filter(e => {
        const st = String(e.service_type || '').toUpperCase();
        if (segmentKey === 'BMS') return st === 'BMS';
        if (segmentKey === 'EXECUTION') return st === 'EXECUTION';
        return st === 'DPR';
      });
    }

    if (projectNameParam) {
      entries = entries.filter(e => {
        const client = String(e.client || '').toLowerCase();
        const details = String(e.project_details || '').toLowerCase();
        const pname = String(e.project_name || '').toLowerCase();
        return pname.includes(projectNameParam) || client.includes(projectNameParam) || details.includes(projectNameParam);
      });
    }

    return res.status(200).json({
      success: true,
      message: "PMC entries fetched successfully.",
      data: entries,
    });
  } catch (error) {
    // Log rich context so 500s surface in logs with query params
    try {
      logger.error("getAllPmcEntries failed", {
        query: req && req.query,
        error: error && error.stack ? error.stack : String(error),
      });
    } catch (logErr) {
      console.error("Failed to log getAllPmcEntries error", logErr);
    }
    console.error("Error fetching PMC entries:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching PMC entries.",
      error: error.message,
    });
  }
};

exports.getPmcEntryById = async (req, res) => {
  try {
    const { pmc_entry_id } = req.params;

    if (!pmc_entry_id) {
      return res.status(400).json({
        success: false,
        message: "pmc_entry_id is required in the URL.",
      });
    }

    const entry = await PmcProject.findByPk(pmc_entry_id, {
      include: [
        {
          model: PmcMilestone,
          as: "milestones",
          separate: true,
          order: [["sr_no", "ASC"]],
        },
      ],
    });

    if (!entry) {
      return res.status(404).json({
        success: false,
        message: "PMC entry not found.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "PMC entry fetched successfully.",
      data: entry,
    });
  } catch (error) {
    try {
      logger.error("getPmcEntryById failed", {
        params: req && req.params,
        error: error && error.stack ? error.stack : String(error),
      });
    } catch (logErr) {
      console.error("Failed to log getPmcEntryById error", logErr);
    }
    console.error("Error fetching PMC entry:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching the PMC entry.",
      error: error.message,
    });
  }
};

exports.createPmcEntry = async (req, res) => {
  try {
    // Accept both camelCase and snake_case keys from client for robustness
    const body = req.body || {};
    const sno = body.sno || body.SNO || body.sr_no || body.srno || null;
    const serviceType = body.serviceType || body.service_type || body.service || null;
    const client = body.client || body.client_name || null;
    const projectDetails = body.projectDetails || body.project_details || body.project_details_text || null;
    const projectName = body.projectName || body.project_name || null;
    const loaDate = body.loaDate || body.loa_date || null;
    const startDate = body.startDate || body.start_date || null;
    const endDate = body.endDate || body.end_date || null;
    const targetDate = body.targetDate || body.target_date || null;
    const totalAmount = body.totalAmount || body.total_amount || Number(body.poValue) || 0;
    const amountReceived = body.amountReceived || body.amount_received || Number(body.amountReceived) || 0;
    const amountPending = body.amountPending || body.amount_pending || Number(body.amount_pending) || 0;
    const status = body.status || body.current_status || 'Pending';
    const milestones = Array.isArray(body.milestones) ? body.milestones : (body.milestoneRows || []);
    
      
      // Fetch the existing entry
      const entry = await PmcProject.findByPk(pmc_entry_id);
      if (!entry) {
        return res.status(404).json({
          success: false,
          message: "PMC entry not found.",
        });
      }

      // Compute display status from milestones (same logic as on frontend):
      let displayStatus = status || 'Pending';
      try {
        if (Array.isArray(milestones) && milestones.length) {
          const raised = milestones.filter(m => Number(m.invoice_raised || m.invoiceRaised || 0) > 0);
          if (raised.length) {
            const last = raised[raised.length - 1];
            displayStatus = last.milestone || displayStatus;
          } else {
            const pending = milestones.filter(m => String(m.status || '').toLowerCase() === 'pending');
            if (pending.length) {
              const last = pending[pending.length - 1];
              displayStatus = last.milestone || last.status || displayStatus;
            }
          }
        }
      } catch (e) {
        console.warn('Error computing displayStatus from milestones', e);
      }

      await entry.update({
        sno,
        service_type: serviceType,
        client,
        project_details: projectDetails,
        project_name: projectName,
        loa_date: loaDate,
        start_date: startDate,
        end_date: endDate,
        target_date: targetDate,
        total_amount: totalAmount,
        amount_received: amountReceived,
        amount_pending: amountPending,
        status: displayStatus,
      });

    await PmcMilestone.destroy({ where: { pmc_entry_id } });
    if (Array.isArray(milestones) && milestones.length) {
      const milestoneRows = milestones.map((m, idx) => ({
        pmc_entry_id,
        sr_no: idx + 1,
        milestone: m.milestone || "",
        stage_payment: Number(m.stagePayment) || 0,
        invoice_amount: Number(m.invoiceAmount) || 0,
        invoice_raised: Number(m.invoiceRaised) || 0,
        invoice_date: m.invoiceDate || null,
        invoice_number: m.invoiceNumber || null,
        status: m.status || "Pending",
      }));
      await PmcMilestone.bulkCreate(milestoneRows);
    }

    return res.status(201).json({
      success: true,
      message: "PMC entry created successfully.",
      data: entry,
    });
  } catch (error) {
    // Log detailed error with request context to the central logger so stack appears in logs
    try {
      const reqBody = req && req.body ? JSON.stringify(req.body) : undefined;
      logger.error('createPmcEntry failed', {
        url: req && req.originalUrl,
        method: req && req.method,
        query: req && req.query,
        body: reqBody,
        error: error && error.stack ? error.stack : String(error),
      });
    } catch (logErr) {
      console.error('Failed to write structured log for createPmcEntry:', logErr);
    }

    console.error("Error creating PMC entry:", error && error.stack ? error.stack : error);
    // If Sequelize validation errors exist, include them in response for easier debugging
    const detail = error && error.errors ? error.errors.map(e => ({ message: e.message, path: e.path, value: e.value })) : undefined;
    return res.status(500).json({
      success: false,
      message: "An error occurred while creating the PMC entry.",
      error: error.message,
      detail,
    });
  }
};

exports.editPmcEntry = async (req, res) => {
  try {
    const { pmc_entry_id } = req.params;
    const body = req.body || {};
    const sno = body.sno || body.SNO || body.sr_no || body.srno || null;
    const serviceType = body.serviceType || body.service_type || body.service || null;
    const client = body.client || body.client_name || null;
    const projectDetails = body.projectDetails || body.project_details || null;
    const projectName = body.projectName || body.project_name || null;
    const loaDate = body.loaDate || body.loa_date || null;
    const startDate = body.startDate || body.start_date || null;
    const endDate = body.endDate || body.end_date || null;
    const targetDate = body.targetDate || body.target_date || null;
    const totalAmount = body.totalAmount || body.total_amount || Number(body.poValue) || 0;
    const amountReceived = body.amountReceived || body.amount_received || Number(body.amountReceived) || 0;
    const amountPending = body.amountPending || body.amount_pending || Number(body.amount_pending) || 0;
    const status = body.status || body.current_status || 'Pending';
    const milestones = Array.isArray(body.milestones) ? body.milestones : (body.milestoneRows || []);
    
      
      // Fetch the existing entry
      const entry = await PmcProject.findByPk(pmc_entry_id);
      if (!entry) {
        return res.status(404).json({
          success: false,
          message: "PMC entry not found.",
        });
      }

      // Compute display status from milestones (same logic as on frontend):
      let displayStatus = status || 'Pending';
      try {
        if (Array.isArray(milestones) && milestones.length) {
          const raised = milestones.filter(m => Number(m.invoice_raised || m.invoiceRaised || 0) > 0);
          if (raised.length) {
            const last = raised[raised.length - 1];
            displayStatus = last.milestone || displayStatus;
          } else {
            const pending = milestones.filter(m => String(m.status || '').toLowerCase() === 'pending');
            if (pending.length) {
              const last = pending[pending.length - 1];
              displayStatus = last.milestone || last.status || displayStatus;
            }
          }
        }
      } catch (e) {
        console.warn('Error computing displayStatus from milestones', e);
      }

      await entry.update({
        sno,
        service_type: serviceType,
        client,
        project_details: projectDetails,
        project_name: projectName,
        loa_date: loaDate,
        start_date: startDate,
        end_date: endDate,
        target_date: targetDate,
        total_amount: totalAmount,
        amount_received: amountReceived,
        amount_pending: amountPending,
        status: displayStatus,
      });

    await PmcMilestone.destroy({ where: { pmc_entry_id } });
    if (Array.isArray(milestones) && milestones.length) {
      const milestoneRows = milestones.map((m, idx) => ({
        pmc_entry_id,
        sr_no: idx + 1,
        milestone: m.milestone || "",
        stage_payment: Number(m.stagePayment) || 0,
        invoice_amount: Number(m.invoiceAmount) || 0,
        invoice_raised: Number(m.invoiceRaised) || 0,
        invoice_date: m.invoiceDate || null,
        invoice_number: m.invoiceNumber || null,
        status: m.status || "Pending",
      }));
      await PmcMilestone.bulkCreate(milestoneRows);
    }

    return res.status(200).json({
      success: true,
      message: "PMC entry updated successfully.",
      data: entry,
    });
  } catch (error) {
    console.error("Error updating PMC entry:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while updating the PMC entry.",
      error: error.message,
    });
  }
};

exports.deletePmcEntry = async (req, res) => {
  try {
    const { pmc_entry_id } = req.params;

    const entry = await PmcProject.findByPk(pmc_entry_id);
    if (!entry) {
      return res.status(404).json({
        success: false,
        message: "PMC entry not found.",
      });
    }

    await PmcMilestone.destroy({ where: { pmc_entry_id } });
    await entry.destroy();

    return res.status(200).json({
      success: true,
      message: "PMC entry deleted successfully.",
    });
  } catch (error) {
    console.error("Error deleting PMC entry:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while deleting the PMC entry.",
      error: error.message,
    });
  }
};

// PMC Consultancy & Engineering Entities CRUD
const normalizePmcCELabel = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const syncPmcCEDeptMappings = async (inputEntities, transaction) => {
  const pmcDepartment = await DeptMaster.findOne({
    where: { dept_name: "PMC" },
    transaction,
  });

  if (!pmcDepartment) {
    throw new Error("PMC department not found.");
  }

  let pmcCEStatistic = await DeptStatistic.findOne({
    where: {
      dept_id: pmcDepartment.dept_id,
      is_active: true,
      [Op.or]: [
        { statistic_name: { [Op.like]: "%consultancy%" } },
        { statistic_name: { [Op.like]: "%engineering%" } },
        { statistic_name: { [Op.like]: "%c&e%" } },
      ],
    },
    order: [["updatedAt", "DESC"]],
    transaction,
  });

  if (!pmcCEStatistic) {
    pmcCEStatistic = await DeptStatistic.create(
      {
        dept_id: pmcDepartment.dept_id,
        statistic_name: "PMC - Consultancy & Engineering Services",
        is_active: true,
        is_shown_on_home: false,
      },
      { transaction },
    );
  }

  if (!pmcCEStatistic.is_active) {
    await pmcCEStatistic.update({ is_active: true }, { transaction });
  }

  const existingDeptEntities = await DeptEntity.findAll({
    where: {
      dept_id: pmcDepartment.dept_id,
      statistic_id: pmcCEStatistic.statistic_id,
    },
    transaction,
  });

  const existingEntityMap = new Map();
  existingDeptEntities.forEach((entity) => {
    const key = normalizePmcCELabel(entity.entity_name);
    if (key && !existingEntityMap.has(key)) {
      existingEntityMap.set(key, entity);
    }
  });

  const syncedEntityIds = [];
  for (const item of inputEntities) {
    const projectName = String(item.projectName || "").trim();
    const projectCapacity = Number(item.projectCapacity) || 0;

    if (!projectName) {
      continue;
    }

    const entityKey = normalizePmcCELabel(projectName);
    const existingDeptEntity = existingEntityMap.get(entityKey);

    if (existingDeptEntity) {
      await existingDeptEntity.update(
        {
          entity_name: projectName,
          entity_value: projectCapacity,
          is_active: true,
        },
        { transaction },
      );
      syncedEntityIds.push(existingDeptEntity.entity_id);
    } else {
      const createdDeptEntity = await DeptEntity.create(
        {
          dept_id: pmcDepartment.dept_id,
          statistic_id: pmcCEStatistic.statistic_id,
          entity_name: projectName,
          entity_value: projectCapacity,
          is_active: true,
        },
        { transaction },
      );
      syncedEntityIds.push(createdDeptEntity.entity_id);
    }
  }

  await DeptEntity.update(
    { is_active: false },
    {
      where: {
        dept_id: pmcDepartment.dept_id,
        statistic_id: pmcCEStatistic.statistic_id,
        ...(syncedEntityIds.length
          ? {
              entity_id: {
                [Op.notIn]: syncedEntityIds,
              },
            }
          : {}),
      },
      transaction,
    },
  );

  return {
    dept_id: pmcDepartment.dept_id,
    statistic_id: pmcCEStatistic.statistic_id,
  };
};

exports.getAllPmcCEEntities = async (req, res) => {
  try {
    const entities = await PmcConsultancyEntity.findAll({
      include: [
        {
          model: PmcConsultancyField,
          as: "fields",
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    const syncTx = await sequelize.transaction();
    try {
      const syncInput = entities.map((entity) => ({
        projectName: entity.project_name,
        projectCapacity: entity.project_capacity,
      }));
      await syncPmcCEDeptMappings(syncInput, syncTx);
      await syncTx.commit();
    } catch (syncError) {
      await syncTx.rollback();
      console.error("Error syncing PMC C&E entity mappings:", syncError);
    }

    return res.status(200).json({
      success: true,
      message: "PMC C&E entities fetched successfully.",
      data: entities,
    });
  } catch (error) {
    console.error("Error fetching PMC C&E entities:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while fetching PMC C&E entities.",
      error: error.message,
    });
  }
};

exports.savePmcCEEntities = async (req, res) => {
  const transaction = await sequelize.transaction();
  try {
    const { entities } = req.body;

    if (!entities || !Array.isArray(entities)) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: "entities array is required.",
      });
    }

    // Clear old data safely (child first) to avoid FK/TRUNCATE errors in MySQL
    await PmcConsultancyField.destroy({ where: {}, transaction });
    await PmcConsultancyEntity.destroy({ where: {}, transaction });

    // Create new entities with their fields
    const createdEntities = [];
    for (const entity of entities) {
      const projectName = String(entity.projectName || "").trim();
      const projectCapacity = Number(entity.projectCapacity) || 0;

      if (!projectName) {
        continue;
      }

      const newEntity = await PmcConsultancyEntity.create({
        project_name: projectName,
        project_capacity: projectCapacity,
      }, { transaction });

      if (entity.fields && Array.isArray(entity.fields)) {
        const fieldsToCreate = entity.fields
          .filter((field) => String(field.name || "").trim() && String(field.value || "").trim())
          .map((field) => ({
            pmc_ce_entity_id: newEntity.pmc_ce_entity_id,
            field_name: String(field.name || "").trim(),
            field_value: String(field.value || "").trim(),
            unit: String(field.unit || "").trim(),
          }));

        if (fieldsToCreate.length) {
          await PmcConsultancyField.bulkCreate(fieldsToCreate, { transaction });
        }
      }

      // Fetch the entity with its fields
      const entityWithFields = await PmcConsultancyEntity.findByPk(
        newEntity.pmc_ce_entity_id,
        {
          include: [{ model: PmcConsultancyField, as: "fields" }],
          transaction,
        }
      );
      createdEntities.push(entityWithFields);
    }

    await syncPmcCEDeptMappings(entities, transaction);

    await transaction.commit();

    return res.status(201).json({
      success: true,
      message: "PMC C&E entities saved successfully.",
      data: createdEntities,
    });
  } catch (error) {
    await transaction.rollback();
    console.error("Error saving PMC C&E entities:", error);
    return res.status(500).json({
      success: false,
      message: "An error occurred while saving PMC C&E entities.",
      error: error.message,
    });
  }
};

exports.getPmcCEEntityContextByLabel = async (req, res) => {
  try {
    const rawLabel = decodeURIComponent(req.params.project_name || "");
    const normalizedLabel = normalizePmcCELabel(rawLabel);

    if (!normalizedLabel) {
      return res.status(400).json({
        success: false,
        message: "Project label is required.",
      });
    }

    const pmcEntities = await PmcConsultancyEntity.findAll({
      attributes: ["project_name", "project_capacity"],
      raw: true,
    });

    const tx = await sequelize.transaction();
    let context;
    try {
      context = await syncPmcCEDeptMappings(
        pmcEntities.map((item) => ({
          projectName: item.project_name,
          projectCapacity: item.project_capacity,
        })),
        tx,
      );
      await tx.commit();
    } catch (syncError) {
      await tx.rollback();
      throw syncError;
    }

    const entities = await DeptEntity.findAll({
      where: {
        dept_id: context.dept_id,
        statistic_id: context.statistic_id,
        is_active: true,
      },
      raw: true,
    });

    let match = entities.find(
      (entity) => normalizePmcCELabel(entity.entity_name) === normalizedLabel,
    );

    if (!match) {
      match = entities.find((entity) => {
        const entityLabel = normalizePmcCELabel(entity.entity_name);
        return (
          entityLabel.includes(normalizedLabel) ||
          normalizedLabel.includes(entityLabel)
        );
      });
    }

    if (!match) {
      return res.status(404).json({
        success: false,
        message: `No matching PMC entity mapping found for: ${rawLabel}`,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        dept_id: context.dept_id,
        statistic_id: context.statistic_id,
        entity_id: match.entity_id,
        entity_name: match.entity_name,
      },
    });
  } catch (error) {
    console.error("Error resolving PMC C&E entity context:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to resolve PMC C&E entity context.",
      error: error.message,
    });
  }
};

// Resolve PMC C&E context from pmc_ce_entity_id
exports.getPmcCEEntityContextById = async (req, res) => {
  try {
    const { pmc_ce_entity_id } = req.params;

    if (!pmc_ce_entity_id) {
      return res.status(400).json({
        success: false,
        message: "pmc_ce_entity_id is required.",
      });
    }

    // Find the PMC C&E entity
    const pmcEntity = await PmcConsultancyEntity.findByPk(pmc_ce_entity_id);
    if (!pmcEntity) {
      return res.status(404).json({
        success: false,
        message: "PMC C&E entity not found.",
      });
    }

    const projectName = pmcEntity.project_name;
    const normalizedLabel = normalizePmcCELabel(projectName);

    // Get all PMC entities for sync
    const pmcEntities = await PmcConsultancyEntity.findAll({
      attributes: ["project_name", "project_capacity"],
      raw: true,
    });

    // Sync PMC C&E to DeptEntity mappings
    const tx = await sequelize.transaction();
    let context;
    try {
      context = await syncPmcCEDeptMappings(
        pmcEntities.map((item) => ({
          projectName: item.project_name,
          projectCapacity: item.project_capacity,
        })),
        tx,
      );
      await tx.commit();
    } catch (syncError) {
      await tx.rollback();
      throw syncError;
    }

    // Find matching DeptEntity
    const entities = await DeptEntity.findAll({
      where: {
        dept_id: context.dept_id,
        statistic_id: context.statistic_id,
        is_active: true,
      },
      raw: true,
    });

    let match = entities.find(
      (entity) => normalizePmcCELabel(entity.entity_name) === normalizedLabel,
    );

    if (!match) {
      match = entities.find((entity) => {
        const entityLabel = normalizePmcCELabel(entity.entity_name);
        return (
          entityLabel.includes(normalizedLabel) ||
          normalizedLabel.includes(entityLabel)
        );
      });
    }

    if (!match) {
      return res.status(404).json({
        success: false,
        message: `No matching DeptEntity found for PMC C&E: ${projectName}`,
      });
    }

    return res.status(200).json({
      success: true,
      dept_id: context.dept_id,
      statistic_id: context.statistic_id,
      entity_id: match.entity_id,
      entity_name: match.entity_name,
      pmc_ce_entity_id: pmc_ce_entity_id,
    });
  } catch (error) {
    console.error("Error resolving PMC C&E entity context by ID:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to resolve PMC C&E entity context.",
      error: error.message,
    });
  }
};

// ========== PMC C&E MILESTONES (consolidated from pmc_ce_milestone_controller.js) ==========
// These functions handle CRUD operations for PMC Consultancy & Engineering project milestones
// Each milestone tracks project progress through stages with invoice tracking

/**
 * Get all milestones for a specific PMC C&E entity
 * Used to display project milestones on the C&E project detail view
 */
exports.getPmcCeMilestones = async (req, res) => {
  try {
    const { pmc_ce_entity_id } = req.params;

    if (!pmc_ce_entity_id) {
      return res.status(400).json({ error: "Missing pmc_ce_entity_id" });
    }

    const milestones = await PmcCeMilestone.findAll({
      where: { pmc_ce_entity_id, is_active: true },
      order: [["sr_no", "ASC"]],
    });

    return res.status(200).json({
      success: true,
      data: milestones,
    });
  } catch (err) {
    console.error("getPmcCeMilestones error:", err);
    return res.status(500).json({ error: "Failed to fetch milestones", detail: err.message });
  }
};

/**
 * Get a single milestone by ID
 * Used for editing a specific milestone
 */
exports.getPmcCeMilestoneById = async (req, res) => {
  try {
    const { pmc_ce_milestone_id } = req.params;

    const milestone = await PmcCeMilestone.findOne({
      where: { pmc_ce_milestone_id, is_active: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found" });
    }

    return res.status(200).json({
      success: true,
      data: milestone,
    });
  } catch (err) {
    console.error("getPmcCeMilestoneById error:", err);
    return res.status(500).json({ error: "Failed to fetch milestone", detail: err.message });
  }
};

/**
 * Create a new milestone for a PMC C&E entity
 * Automatically assigns sr_no (serial number) if not provided
 */
exports.createPmcCeMilestone = async (req, res) => {
  try {
    const {
      pmc_ce_entity_id,
      milestone,
      stage_payment,
      invoice_amount,
      invoice_raised,
      invoice_date,
      invoice_number,
      status,
      sr_no,
    } = req.body;

    if (!pmc_ce_entity_id || !milestone) {
      return res.status(400).json({ error: "pmc_ce_entity_id and milestone are required" });
    }

    // Verify entity exists
    const entity = await PmcConsultancyEntity.findByPk(pmc_ce_entity_id);
    if (!entity) {
      return res.status(404).json({ error: "PMC C&E entity not found" });
    }

    // Get next sr_no if not provided
    let nextSrNo = sr_no;
    if (nextSrNo === undefined || nextSrNo === null) {
      const maxSrNo = await PmcCeMilestone.max("sr_no", {
        where: { pmc_ce_entity_id },
      });
      nextSrNo = (maxSrNo || 0) + 1;
    }

    const newMilestone = await PmcCeMilestone.create({
      pmc_ce_entity_id,
      milestone,
      stage_payment: stage_payment || 0,
      invoice_amount: invoice_amount || 0,
      invoice_raised: invoice_raised || 0,
      invoice_date: invoice_date || null,
      invoice_number: invoice_number || null,
      status: status || "Pending",
      sr_no: nextSrNo,
    });

    return res.status(201).json({
      success: true,
      message: "Milestone created successfully",
      data: newMilestone,
    });
  } catch (err) {
    console.error("createPmcCeMilestone error:", err);
    return res.status(500).json({ error: "Failed to create milestone", detail: err.message });
  }
};

/**
 * Update an existing milestone
 * Allows modification of milestone details, invoice tracking, and status
 */
exports.updatePmcCeMilestone = async (req, res) => {
  try {
    const { pmc_ce_milestone_id } = req.params;
    const {
      milestone,
      stage_payment,
      invoice_amount,
      invoice_raised,
      invoice_date,
      invoice_number,
      status,
      sr_no,
    } = req.body;

    const existingMilestone = await PmcCeMilestone.findOne({
      where: { pmc_ce_milestone_id, is_active: true },
    });

    if (!existingMilestone) {
      return res.status(404).json({ error: "Milestone not found" });
    }

    await existingMilestone.update({
      milestone: milestone !== undefined ? milestone : existingMilestone.milestone,
      stage_payment: stage_payment !== undefined ? stage_payment : existingMilestone.stage_payment,
      invoice_amount: invoice_amount !== undefined ? invoice_amount : existingMilestone.invoice_amount,
      invoice_raised: invoice_raised !== undefined ? invoice_raised : existingMilestone.invoice_raised,
      invoice_date: invoice_date !== undefined ? invoice_date : existingMilestone.invoice_date,
      invoice_number: invoice_number !== undefined ? invoice_number : existingMilestone.invoice_number,
      status: status !== undefined ? status : existingMilestone.status,
      sr_no: sr_no !== undefined ? sr_no : existingMilestone.sr_no,
    });

    return res.status(200).json({
      success: true,
      message: "Milestone updated successfully",
      data: existingMilestone,
    });
  } catch (err) {
    console.error("updatePmcCeMilestone error:", err);
    return res.status(500).json({ error: "Failed to update milestone", detail: err.message });
  }
};

/**
 * Delete a milestone (soft delete)
 * Sets is_active to false to preserve historical data
 */
exports.deletePmcCeMilestone = async (req, res) => {
  try {
    const { pmc_ce_milestone_id } = req.params;

    const milestone = await PmcCeMilestone.findOne({
      where: { pmc_ce_milestone_id, is_active: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found" });
    }

    await milestone.update({ is_active: false });

    return res.status(200).json({
      success: true,
      message: "Milestone deleted successfully",
    });
  } catch (err) {
    console.error("deletePmcCeMilestone error:", err);
    return res.status(500).json({ error: "Failed to delete milestone", detail: err.message });
  }
};

/**
 * Bulk save/update milestones for an entity
 * Useful for form submissions with multiple milestones
 * Soft-deletes existing milestones and creates new ones to ensure clean state
 */
exports.bulkSavePmcCeMilestones = async (req, res) => {
  try {
    const { pmc_ce_entity_id, milestones } = req.body;

    if (!pmc_ce_entity_id) {
      return res.status(400).json({ error: "pmc_ce_entity_id is required" });
    }

    if (!Array.isArray(milestones)) {
      return res.status(400).json({ error: "milestones must be an array" });
    }

    // Verify entity exists
    const entity = await PmcConsultancyEntity.findByPk(pmc_ce_entity_id);
    if (!entity) {
      return res.status(404).json({ error: "PMC C&E entity not found" });
    }

    // Soft-delete existing milestones
    await PmcCeMilestone.update(
      { is_active: false },
      { where: { pmc_ce_entity_id } }
    );

    // Create new milestones with sr_no
    const milestoneRows = milestones.map((m, idx) => ({
      pmc_ce_entity_id,
      sr_no: idx + 1,
      milestone: m.milestone || "",
      stage_payment: m.stage_payment || 0,
      invoice_amount: m.invoice_amount || 0,
      invoice_raised: m.invoice_raised || 0,
      invoice_date: m.invoice_date || null,
      invoice_number: m.invoice_number || null,
      status: m.status || "Pending",
      is_active: true,
    }));

    const created = await PmcCeMilestone.bulkCreate(milestoneRows);

    return res.status(200).json({
      success: true,
      message: "Milestones saved successfully",
      data: created,
    });
  } catch (err) {
    console.error("bulkSavePmcCeMilestones error:", err);
    return res.status(500).json({ error: "Failed to save milestones", detail: err.message });
  }
};

/**
 * Developer Payment controllers
 */
exports.getAllDeveloperPayments = async (req, res) => {
  try {
    const { DeveloperPayment } = require("../models").models;
    const project = req.query.project;
    const options = { order: [["createdAt", "DESC"]] };
    if (project) options.where = { project_name: project };
    const items = await DeveloperPayment.findAll(options);
    return res.json(items);
  } catch (err) {
    console.error("getAllDeveloperPayments error:", err);
    return res.status(500).json({ error: "Failed to fetch developer payments", detail: err.message });
  }
};

exports.getDeveloperPaymentById = async (req, res) => {
  try {
    const { DeveloperPayment } = require("../models").models;
    const id = req.params.id;
    const item = await DeveloperPayment.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json(item);
  } catch (err) {
    console.error("getDeveloperPaymentById error:", err);
    return res.status(500).json({ error: "Failed to fetch developer payment", detail: err.message });
  }
};

exports.createDeveloperPayment = async (req, res) => {
  try {
    const { DeveloperPayment } = require("../models").models;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!document_name || !document_date) {
      return res.status(400).json({ error: "document_name and document_date are required" });
    }

    if (!filePath) {
      return res.status(400).json({ error: "File upload is required" });
    }

    const created = await DeveloperPayment.create({
      document_name,
      document_date,
      document_path: filePath,
      project_name: project_name || null,
    });

    return res.json(created);
  } catch (err) {
    console.error("createDeveloperPayment error:", err);
    return res.status(500).json({ error: "Failed to create developer payment", detail: err.message });
  }
};

exports.editDeveloperPayment = async (req, res) => {
  try {
    const { DeveloperPayment } = require("../models").models;
    const id = req.params.id;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    const item = await DeveloperPayment.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });

    item.document_name = document_name || item.document_name;
    item.document_date = document_date || item.document_date;
    item.project_name = project_name || item.project_name;
    if (filePath) item.document_path = filePath;

    await item.save();
    return res.json(item);
  } catch (err) {
    console.error("editDeveloperPayment error:", err);
    return res.status(500).json({ error: "Failed to edit developer payment", detail: err.message });
  }
};

exports.deleteDeveloperPayment = async (req, res) => {
  try {
    const { DeveloperPayment } = require("../models").models;
    const id = req.params.id;
    const item = await DeveloperPayment.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    await item.destroy();
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteDeveloperPayment error:", err);
    return res.status(500).json({ error: "Failed to delete developer payment", detail: err.message });
  }
};

/**
 * Power Sale controllers
 */
exports.getAllPowerSales = async (req, res) => {
  try {
    const { PowerSale } = require("../models").models;
    const project = req.query.project;
    const options = { order: [["createdAt", "DESC"]] };
    if (project) options.where = { project_name: project };
    const items = await PowerSale.findAll(options);
    return res.json(items);
  } catch (err) {
    console.error("getAllPowerSales error:", err);
    return res.status(500).json({ error: "Failed to fetch power sales", detail: err.message });
  }
};

exports.getPowerSaleById = async (req, res) => {
  try {
    const { PowerSale } = require("../models").models;
    const id = req.params.id;
    const item = await PowerSale.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json(item);
  } catch (err) {
    console.error("getPowerSaleById error:", err);
    return res.status(500).json({ error: "Failed to fetch power sale", detail: err.message });
  }
};

exports.createPowerSale = async (req, res) => {
  try {
    const { PowerSale } = require("../models").models;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!document_name || !document_date) {
      return res.status(400).json({ error: "document_name and document_date are required" });
    }

    if (!filePath) {
      return res.status(400).json({ error: "File upload is required" });
    }

    const created = await PowerSale.create({
      document_name,
      document_date,
      document_path: filePath,
      project_name: project_name || null,
    });

    return res.json(created);
  } catch (err) {
    console.error("createPowerSale error:", err);
    return res.status(500).json({ error: "Failed to create power sale", detail: err.message });
  }
};

exports.editPowerSale = async (req, res) => {
  try {
    const { PowerSale } = require("../models").models;
    const id = req.params.id;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    const item = await PowerSale.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });

    item.document_name = document_name || item.document_name;
    item.document_date = document_date || item.document_date;
    item.project_name = project_name || item.project_name;
    if (filePath) item.document_path = filePath;

    await item.save();
    return res.json(item);
  } catch (err) {
    console.error("editPowerSale error:", err);
    return res.status(500).json({ error: "Failed to edit power sale", detail: err.message });
  }
};

exports.deletePowerSale = async (req, res) => {
  try {
    const { PowerSale } = require("../models").models;
    const id = req.params.id;
    const item = await PowerSale.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    await item.destroy();
    return res.json({ ok: true });
  } catch (err) {
    console.error("deletePowerSale error:", err);
    return res.status(500).json({ error: "Failed to delete power sale", detail: err.message });
  }
};

/**
 * DISCOM Payment controllers
 */
exports.getAllDiscomPayments = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const project = req.query.project;
    const options = { order: [["createdAt", "DESC"]] };
    if (project) options.where = { project_name: project };
    const items = await DiscomPayments.findAll(options);
    return res.json(items);
  } catch (err) {
    console.error("getAllDiscomPayments error:", err);
    return res.status(500).json({ error: "Failed to fetch discom payments", detail: err.message });
  }
};

exports.getDiscomPaymentById = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const id = req.params.id;
    const item = await DiscomPayments.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json(item);
  } catch (err) {
    console.error("getDiscomPaymentById error:", err);
    return res.status(500).json({ error: "Failed to fetch discom payment", detail: err.message });
  }
};

exports.createDiscomPayment = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!document_name || !document_date) {
      return res.status(400).json({ error: "document_name and document_date are required" });
    }

    if (!filePath) {
      return res.status(400).json({ error: "File upload is required" });
    }

    const created = await DiscomPayments.create({
      document_name,
      document_date,
      document_path: filePath,
      project_name: project_name || null,
    });

    return res.json(created);
  } catch (err) {
    console.error("createDiscomPayment error:", err);
    return res.status(500).json({ error: "Failed to create discom payment", detail: err.message });
  }
};

exports.editDiscomPayment = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const id = req.params.id;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    const item = await DiscomPayments.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });

    item.document_name = document_name || item.document_name;
    item.document_date = document_date || item.document_date;
    item.project_name = project_name || item.project_name;
    if (filePath) item.document_path = filePath;

    await item.save();
    return res.json(item);
  } catch (err) {
    console.error("editDiscomPayment error:", err);
    return res.status(500).json({ error: "Failed to edit discom payment", detail: err.message });
  }
};

exports.deleteDiscomPayment = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const id = req.params.id;
    const item = await DiscomPayments.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    await item.destroy();
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteDiscomPayment error:", err);
    return res.status(500).json({ error: "Failed to delete discom payment", detail: err.message });
  }
};

/**
 * Regulatory Order controllers
 */
exports.getAllRegulatoryOrders = async (req, res) => {
  try {
    const { RegulatoryOrder } = require("../models").models;
    const project = req.query.project;
    const options = { order: [["createdAt", "DESC"]] };
    if (project) options.where = { project_name: project };
    const items = await RegulatoryOrder.findAll(options);
    return res.json(items);
  } catch (err) {
    console.error("getAllRegulatoryOrders error:", err);
    return res.status(500).json({ error: "Failed to fetch regulatory orders", detail: err.message });
  }
};

exports.getRegulatoryOrderById = async (req, res) => {
  try {
    const { RegulatoryOrder } = require("../models").models;
    const id = req.params.id;
    const item = await RegulatoryOrder.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json(item);
  } catch (err) {
    console.error("getRegulatoryOrderById error:", err);
    return res.status(500).json({ error: "Failed to fetch regulatory order", detail: err.message });
  }
};

exports.createRegulatoryOrder = async (req, res) => {
  try {
    const { RegulatoryOrder } = require("../models").models;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!document_name || !document_date) {
      return res.status(400).json({ error: "document_name and document_date are required" });
    }

    if (!filePath) {
      return res.status(400).json({ error: "File upload is required" });
    }

    const created = await RegulatoryOrder.create({
      document_name,
      document_date,
      document_path: filePath,
      project_name: project_name || null,
    });

    return res.json(created);
  } catch (err) {
    console.error("createRegulatoryOrder error:", err);
    return res.status(500).json({ error: "Failed to create regulatory order", detail: err.message });
  }
};

exports.editRegulatoryOrder = async (req, res) => {
  try {
    const { RegulatoryOrder } = require("../models").models;
    const id = req.params.id;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    const item = await RegulatoryOrder.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });

    item.document_name = document_name || item.document_name;
    item.document_date = document_date || item.document_date;
    item.project_name = project_name || item.project_name;
    if (filePath) item.document_path = filePath;

    await item.save();
    return res.json(item);
  } catch (err) {
    console.error("editRegulatoryOrder error:", err);
    return res.status(500).json({ error: "Failed to edit regulatory order", detail: err.message });
  }
};

exports.deleteRegulatoryOrder = async (req, res) => {
  try {
    const { RegulatoryOrder } = require("../models").models;
    const id = req.params.id;
    const item = await RegulatoryOrder.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    await item.destroy();
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteRegulatoryOrder error:", err);
    return res.status(500).json({ error: "Failed to delete regulatory order", detail: err.message });
  }
};

/**
 * State Wise Details controllers
 */
exports.getAllStateWiseDetails = async (req, res) => {
  try {
    const { StateWiseDetail } = require("../models").models;
    const project = req.query.project;
    const options = { order: [["createdAt", "DESC"]] };
    if (project) options.where = { project_name: project };
    const items = await StateWiseDetail.findAll(options);
    return res.json(items);
  } catch (err) {
    console.error("getAllStateWiseDetails error:", err);
    return res.status(500).json({ error: "Failed to fetch state wise details", detail: err.message });
  }
};

exports.getStateWiseDetailById = async (req, res) => {
  try {
    const { StateWiseDetail } = require("../models").models;
    const id = req.params.id;
    const item = await StateWiseDetail.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json(item);
  } catch (err) {
    console.error("getStateWiseDetailById error:", err);
    return res.status(500).json({ error: "Failed to fetch state wise detail", detail: err.message });
  }
};

exports.createStateWiseDetail = async (req, res) => {
  try {
    const { StateWiseDetail } = require("../models").models;
    const { discom_name, state, psa_signed_mw, commissioned_mw, project_name } = req.body;

    const regulationsFile = req.files && req.files.regulations && req.files.regulations[0];
    const reportFile = req.files && req.files.report && req.files.report[0];

    if (!discom_name || !state) {
      return res.status(400).json({ error: "discom_name and state are required" });
    }

    if (!regulationsFile) {
      return res.status(400).json({ error: "Regulations file is required" });
    }

    const created = await StateWiseDetail.create({
      discom_name,
      state,
      psa_signed_mw: psa_signed_mw || 0,
      commissioned_mw: commissioned_mw || 0,
      regulations_policy_path: regulationsFile.path,
      report_path: reportFile ? reportFile.path : null,
      project_name: project_name || null,
    });

    return res.json(created);
  } catch (err) {
    console.error("createStateWiseDetail error:", err);
    return res.status(500).json({ error: "Failed to create state wise detail", detail: err.message });
  }
};

exports.editStateWiseDetail = async (req, res) => {
  try {
    const { StateWiseDetail } = require("../models").models;
    const id = req.params.id;
    const { discom_name, state, psa_signed_mw, commissioned_mw, project_name } = req.body;

    const regulationsFile = req.files && req.files.regulations && req.files.regulations[0];
    const reportFile = req.files && req.files.report && req.files.report[0];

    const item = await StateWiseDetail.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });

    item.discom_name = discom_name || item.discom_name;
    item.state = state || item.state;
    item.psa_signed_mw = psa_signed_mw || item.psa_signed_mw;
    item.commissioned_mw = commissioned_mw || item.commissioned_mw;
    item.project_name = project_name || item.project_name;
    if (regulationsFile) item.regulations_policy_path = regulationsFile.path;
    if (reportFile) item.report_path = reportFile.path;

    await item.save();
    return res.json(item);
  } catch (err) {
    console.error("editStateWiseDetail error:", err);
    return res.status(500).json({ error: "Failed to edit state wise detail", detail: err.message });
  }
};

exports.deleteStateWiseDetail = async (req, res) => {
  try {
    const { StateWiseDetail } = require("../models").models;
    const id = req.params.id;
    const item = await StateWiseDetail.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    await item.destroy();
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteStateWiseDetail error:", err);
    return res.status(500).json({ error: "Failed to delete state wise detail", detail: err.message });
  }
};

/**
 * DISCOM Payment controllers
 */
exports.getAllDiscomPayments = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const project = req.query.project;
    const options = { order: [["createdAt", "DESC"]] };
    if (project) options.where = { project_name: project };
    const items = await DiscomPayments.findAll(options);
    return res.json(items);
  } catch (err) {
    console.error("getAllDiscomPayments error:", err);
    return res.status(500).json({ error: "Failed to fetch discom payments", detail: err.message });
  }
};

exports.getDiscomPaymentById = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const id = req.params.id;
    const item = await DiscomPayments.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    return res.json(item);
  } catch (err) {
    console.error("getDiscomPaymentById error:", err);
    return res.status(500).json({ error: "Failed to fetch discom payment", detail: err.message });
  }
};

exports.createDiscomPayment = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    if (!document_name || !document_date) {
      return res.status(400).json({ error: "document_name and document_date are required" });
    }

    if (!filePath) {
      return res.status(400).json({ error: "File upload is required" });
    }

    const created = await DiscomPayments.create({
      document_name,
      document_date,
      document_path: filePath,
      project_name: project_name || null,
    });

    return res.json(created);
  } catch (err) {
    console.error("createDiscomPayment error:", err);
    return res.status(500).json({ error: "Failed to create discom payment", detail: err.message });
  }
};

exports.editDiscomPayment = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const id = req.params.id;
    const { document_name, document_date, project_name } = req.body;
    const filePath = req.file ? req.file.path : null;

    const item = await DiscomPayments.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });

    item.document_name = document_name || item.document_name;
    item.document_date = document_date || item.document_date;
    item.project_name = project_name || item.project_name;
    if (filePath) item.document_path = filePath;

    await item.save();
    return res.json(item);
  } catch (err) {
    console.error("editDiscomPayment error:", err);
    return res.status(500).json({ error: "Failed to edit discom payment", detail: err.message });
  }
};

exports.deleteDiscomPayment = async (req, res) => {
  try {
    const { DiscomPayments } = require("../models").models;
    const id = req.params.id;
    const item = await DiscomPayments.findByPk(id);
    if (!item) return res.status(404).json({ error: "Not found" });
    await item.destroy();
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteDiscomPayment error:", err);
    return res.status(500).json({ error: "Failed to delete discom payment", detail: err.message });
  }
};

/**
 *
 * QA (Quality Assurance) Controllers
 *
 */

// ── QA Registered Projects ──────────────────────────────────────────────
exports.getAllQaRegisteredProjects = async (req, res) => {
  try {
    const projects = await QaRegisteredProject.findAll({
      order: [["createdAt", "DESC"]],
    });
    return res.status(200).json({ success: true, data: projects });
  } catch (err) {
    console.error("getAllQaRegisteredProjects error:", err);
    return res.status(500).json({ success: false, message: "Failed to load QA projects" });
  }
};

exports.createQaRegisteredProject = async (req, res) => {
  try {
    const {
      project_name,
      project_details,
      rfb_details,
      ca_no,
      bbu_no,
      po_no,
      loa_no,
      contractor_name,
      contractor_address,
      mdcc_no,
    } = req.body;

    if (!project_name) {
      return res.status(400).json({ success: false, message: "Project name is required" });
    }

    const project = await QaRegisteredProject.create({
      project_name,
      project_details: project_details || null,
      rfb_details: rfb_details || null,
      ca_no: ca_no || null,
      bbu_no: bbu_no || null,
      po_no: po_no || null,
      loa_no: loa_no || null,
      contractor_name: contractor_name || null,
      contractor_address: contractor_address || null,
      mdcc_no: mdcc_no || null,
    });

    return res.status(201).json({ success: true, data: project, message: "Project registered successfully" });
  } catch (err) {
    console.error("createQaRegisteredProject error:", err);
    return res.status(500).json({ success: false, message: "Failed to register project" });
  }
};

exports.editQaRegisteredProject = async (req, res) => {
  try {
    const { qa_project_id } = req.params;
    const project = await QaRegisteredProject.findByPk(qa_project_id);
    if (!project) return res.status(404).json({ success: false, message: "Project not found" });

    const {
      project_name,
      project_details,
      rfb_details,
      ca_no,
      bbu_no,
      po_no,
      loa_no,
      contractor_name,
      contractor_address,
      mdcc_no,
    } = req.body;

    if (project_name !== undefined) project.project_name = project_name;
    if (project_details !== undefined) project.project_details = project_details;
    if (rfb_details !== undefined) project.rfb_details = rfb_details;
    if (ca_no !== undefined) project.ca_no = ca_no;
    if (bbu_no !== undefined) project.bbu_no = bbu_no;
    if (po_no !== undefined) project.po_no = po_no;
    if (loa_no !== undefined) project.loa_no = loa_no;
    if (contractor_name !== undefined) project.contractor_name = contractor_name;
    if (contractor_address !== undefined) project.contractor_address = contractor_address;
    if (mdcc_no !== undefined) project.mdcc_no = mdcc_no;

    await project.save();
    return res.status(200).json({ success: true, data: project, message: "Project updated successfully" });
  } catch (err) {
    console.error("editQaRegisteredProject error:", err);
    return res.status(500).json({ success: false, message: "Failed to update project" });
  }
};

exports.deleteQaRegisteredProject = async (req, res) => {
  try {
    const { qa_project_id } = req.params;
    const project = await QaRegisteredProject.findByPk(qa_project_id);
    if (!project) return res.status(404).json({ success: false, message: "Project not found" });

    await QaBbu.destroy({ where: { qa_project_id } });
    await QaMdcc.destroy({ where: { qa_project_id } });
    await project.destroy();

    return res.status(200).json({ success: true, message: "Project deleted successfully" });
  } catch (err) {
    console.error("deleteQaRegisteredProject error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete project" });
  }
};

// ── QA BBU (Bill of Quantities) ─────────────────────────────────────────
exports.getQaBbuByProject = async (req, res) => {
  try {
    const { qa_project_id } = req.params;
    const rows = await QaBbu.findAll({
      where: { qa_project_id },
      order: [["bbu_sl_no", "ASC"]],
    });
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error("getQaBbuByProject error:", err);
    return res.status(500).json({ success: false, message: "Failed to load BBU entries" });
  }
};

exports.createQaBbu = async (req, res) => {
  try {
    const { qa_project_id } = req.params;
    const {
      bbu_sl_no,
      name_equipment,
      uom,
      item_category,
      quantity,
      unit_price,
      basic_price,
      gst_percent,
      gst,
      total_value,
    } = req.body;

    if (!name_equipment) {
      return res.status(400).json({ success: false, message: "Equipment name is required" });
    }

    const row = await QaBbu.create({
      qa_project_id,
      bbu_sl_no: bbu_sl_no != null ? bbu_sl_no : 0,
      name_equipment,
      uom: uom || null,
      item_category: item_category || null,
      quantity: quantity != null ? quantity : null,
      unit_price: unit_price != null ? unit_price : null,
      basic_price: basic_price != null ? basic_price : null,
      gst_percent: gst_percent || null,
      gst: gst != null ? gst : null,
      total_value: total_value != null ? total_value : null,
    });

    return res.status(201).json({ success: true, data: row, message: "BBU entry added" });
  } catch (err) {
    console.error("createQaBbu error:", err);
    return res.status(500).json({ success: false, message: "Failed to add BBU entry" });
  }
};

exports.editQaBbu = async (req, res) => {
  try {
    const { bbu_id } = req.params;
    const row = await QaBbu.findByPk(bbu_id);
    if (!row) return res.status(404).json({ success: false, message: "BBU entry not found" });

    const {
      bbu_sl_no,
      name_equipment,
      uom,
      item_category,
      quantity,
      unit_price,
      basic_price,
      gst_percent,
      gst,
      total_value,
    } = req.body;

    if (bbu_sl_no !== undefined) row.bbu_sl_no = bbu_sl_no;
    if (name_equipment !== undefined) row.name_equipment = name_equipment;
    if (uom !== undefined) row.uom = uom;
    if (item_category !== undefined) row.item_category = item_category;
    if (quantity !== undefined) row.quantity = quantity;
    if (unit_price !== undefined) row.unit_price = unit_price;
    if (basic_price !== undefined) row.basic_price = basic_price;
    if (gst_percent !== undefined) row.gst_percent = gst_percent;
    if (gst !== undefined) row.gst = gst;
    if (total_value !== undefined) row.total_value = total_value;

    await row.save();
    return res.status(200).json({ success: true, data: row, message: "BBU entry updated" });
  } catch (err) {
    console.error("editQaBbu error:", err);
    return res.status(500).json({ success: false, message: "Failed to update BBU entry" });
  }
};

exports.deleteQaBbu = async (req, res) => {
  try {
    const { bbu_id } = req.params;
    const row = await QaBbu.findByPk(bbu_id);
    if (!row) return res.status(404).json({ success: false, message: "BBU entry not found" });
    await row.destroy();
    return res.status(200).json({ success: true, message: "BBU entry deleted" });
  } catch (err) {
    console.error("deleteQaBbu error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete BBU entry" });
  }
};

// ── QA BBU Excel Upload ─────────────────────────────────────────────────
function normalizeBbuHeader(key) {
  return String(key || "")
    .toLowerCase()
    .replace(/%/g, "percent")
    .replace(/[^a-z0-9]/g, "");
}

function mapBbuExcelRow(rawRow) {
  const mapping = {
    bbu_sl_no: ["bbuslno", "slno", "sno", "sino", "serialno", "sl", "no", "si"],
    bbu_item_sl_no: ["bbuitemslno", "itemslno", "bbuitemno", "itemno", "bbuitemserialno"],
    item_category: ["itemcategory", "category", "itemcat", "cat"],
    name_equipment: ["nameequipment", "nameofequipment", "equipmentname", "descriptionofequipment", "equipment", "itemdescription", "itemname", "description", "particulars", "item", "name"],
    uom: ["uom", "unit", "unitofmeasurement", "unitofmeasure", "measurementunit", "unitoflmeasurement"],
    quantity: ["quantity", "qty", "qtyasperbbu", "totalquantity"],
    unit_price: ["unitprice", "rate", "priceperunit", "unitrate"],
    basic_price: ["basicprice", "basicamount", "baseprice", "amount", "basic"],
    gst: ["gstamount", "tax", "cgst", "sgst", "gst", "gstvalue"],
    gst_percent: ["gstpercent", "gstratepercent", "gstpercentage", "gstrate"],
    total_value: ["totalvalue", "total", "value", "totalcost", "cost", "amounttotal", "totalamount", "grandtotal"],
  };

  const fieldMap = {};
  const exact = {};
  Object.keys(rawRow).forEach((key) => {
    exact[normalizeBbuHeader(key)] = key;
  });

  const normalizedKeys = Object.keys(exact);
  Object.keys(mapping).forEach((field) => {
    const aliases = mapping[field];
    for (const alias of aliases) {
      if (exact[alias] !== undefined) {
        fieldMap[field] = exact[alias];
        break;
      }
    }
    if (fieldMap[field] === undefined) {
      // Fallback: contains match (e.g. "BBU SL. NO." normalized to "bbuslno")
      const hit = normalizedKeys.find((nk) => aliases.some((alias) => nk.includes(alias)));
      if (hit) {
        fieldMap[field] = exact[hit];
      }
    }
  });

  const num = (v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(String(v).replace(/[,₹\s]/g, ""));
    return isNaN(n) ? null : n;
  };
  const str = (v) => (v === null || v === undefined || v === "" ? null : String(v).trim());

  let gst_percent_val = str(rawRow[fieldMap.gst_percent]);
  if (gst_percent_val && !gst_percent_val.includes('%')) {
    let numGstP = Number(gst_percent_val);
    if (!isNaN(numGstP)) {
      if (numGstP > 0 && numGstP < 1) {
        gst_percent_val = (numGstP * 100) + '%';
      } else {
        gst_percent_val = numGstP + '%';
      }
    }
  }

  return {
    bbu_sl_no: str(rawRow[fieldMap.bbu_sl_no]),
    bbu_item_sl_no: str(rawRow[fieldMap.bbu_item_sl_no]),
    item_category: str(rawRow[fieldMap.item_category]),
    name_equipment: str(rawRow[fieldMap.name_equipment]),
    uom: str(rawRow[fieldMap.uom]),
    quantity: num(rawRow[fieldMap.quantity]),
    unit_price: num(rawRow[fieldMap.unit_price]),
    basic_price: num(rawRow[fieldMap.basic_price]),
    gst: num(rawRow[fieldMap.gst]),
    gst_percent: gst_percent_val,
    total_value: num(rawRow[fieldMap.total_value]),
  };
}

exports.uploadQaBbuExcel = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Excel file is required" });
    }

    const { qa_project_id } = req.params;
    const existingCount = await QaBbu.count({ where: { qa_project_id } });
    if (existingCount > 0) {
      return res.status(400).json({ success: false, message: "BBU has already been uploaded for this project. BBU can only be uploaded once per project." });
    }

    const xlsx = require("xlsx");
    const workbook = xlsx.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    if (!raw || raw.length === 0) {
      return res.status(400).json({ success: false, message: "Excel file is empty" });
    }

    // Detect header row: first row containing a recognizable BBU header
    let headerRowIndex = 0;
    for (let i = 0; i < Math.min(raw.length, 5); i++) {
      const joined = String(raw[i].join(" ")).toLowerCase();
      if (/bbu|sl\s*\.?\s*no|equipment|uom|quantity|unit\s*price|basic\s*price|gst|total/i.test(joined)) {
        headerRowIndex = i;
        break;
      }
    }

    const headerRow = raw[headerRowIndex];
    const colMap = {};
    headerRow.forEach((h, i) => {
      const key = String(h || "").trim();
      if (key) colMap[i] = key;
    });

    let inserted = 0;
    let skipped = 0;

    for (let r = headerRowIndex + 1; r < raw.length; r++) {
      const rowArr = raw[r];
      const hasVal = rowArr.some((v) => String(v || "").trim() !== "");
      if (!hasVal) continue;

      const rawObj = {};
      for (let i = 0; i < headerRow.length; i++) {
        if (colMap[i]) rawObj[colMap[i]] = rowArr[i] !== undefined ? rowArr[i] : "";
      }

      const mapped = mapBbuExcelRow(rawObj);
      if (!mapped.name_equipment) {
        skipped += 1;
        continue;
      }

      await QaBbu.create({
        qa_project_id,
        bbu_sl_no: mapped.bbu_sl_no != null ? mapped.bbu_sl_no : String(inserted + 1),
        bbu_item_sl_no: mapped.bbu_item_sl_no || null,
        item_category: mapped.item_category || null,
        name_equipment: mapped.name_equipment,
        uom: mapped.uom,
        quantity: mapped.quantity,
        unit_price: mapped.unit_price,
        basic_price: mapped.basic_price,
        gst: mapped.gst,
        gst_percent: mapped.gst_percent || null,
        total_value: mapped.total_value,
      });
      inserted += 1;
    }

    return res.status(200).json({
      success: true,
      message: `BBU Excel uploaded: ${inserted} entries created${skipped ? `, ${skipped} rows skipped` : ""}`,
      data: { createdCount: inserted, skippedCount: skipped },
    });
  } catch (err) {
    console.error("uploadQaBbuExcel error:", err);
    return res.status(500).json({ success: false, message: "Failed to process BBU Excel", detail: err.message });
  }
};

// ── QA MDCC ─────────────────────────────────────────────────────────────
exports.getQaMdccByProject = async (req, res) => {
  try {
    const { qa_project_id } = req.params;
    const rows = await QaMdcc.findAll({
      where: { qa_project_id },
      order: [["createdAt", "DESC"]],
    });
    return res.status(200).json({ success: true, data: rows });
  } catch (err) {
    console.error("getQaMdccByProject error:", err);
    return res.status(500).json({ success: false, message: "Failed to load MDCC entries" });
  }
};

exports.createQaMdcc = async (req, res) => {
  try {
    const { qa_project_id } = req.params;
    const {
      mdcc_no,
      mdcc_date,
      project_details,
      rfb_details,
      ca_no,
      bbu_ref_no,
      po_no,
      loa_no,
      contractor_name,
      contractor_address,
      bbu_sl_no,
      bbu_item_sl_no,
      item_material_description,
      uom,
      mt,
      qty_as_per_bbu,
      mdcc_issued_till_date,
      mdcc_issued_for,
      manufacturer,
      inspect,
      remarks,
      mdcc_items,
      inspected_by,
      mandays,
      uploaded_files,
    } = req.body;

    if (!mdcc_no || !mdcc_date) {
      return res.status(400).json({ success: false, message: "MDCC No. and MDCC Date are required" });
    }

    const row = await QaMdcc.create({
      qa_project_id,
      mdcc_no,
      mdcc_date,
      project_details: project_details || null,
      rfb_details: rfb_details || null,
      ca_no: ca_no || null,
      bbu_ref_no: bbu_ref_no || null,
      po_no: po_no || null,
      loa_no: loa_no || null,
      contractor_name: contractor_name || null,
      contractor_address: contractor_address || null,
      bbu_sl_no: bbu_sl_no != null ? bbu_sl_no : null,
      bbu_item_sl_no: bbu_item_sl_no != null ? bbu_item_sl_no : null,
      item_material_description: item_material_description || null,
      uom: uom || null,
      mt: mt || null,
      qty_as_per_bbu: qty_as_per_bbu != null ? qty_as_per_bbu : null,
      mdcc_issued_till_date: mdcc_issued_till_date != null ? mdcc_issued_till_date : 0,
      mdcc_issued_for: mdcc_issued_for || null,
      manufacturer: manufacturer || null,
      inspect: inspect || null,
      remarks: remarks || null,
      mdcc_items: mdcc_items || null,
      inspected_by: inspected_by || null,
      mandays: mandays || null,
      uploaded_files: uploaded_files || null,
    });

    return res.status(201).json({ success: true, data: row, message: "MDCC entry added" });
  } catch (err) {
    console.error("createQaMdcc error:", err);
    return res.status(500).json({ success: false, message: "Failed to add MDCC entry" });
  }
};

exports.editQaMdcc = async (req, res) => {
  try {
    const { mdcc_id } = req.params;
    const row = await QaMdcc.findByPk(mdcc_id);
    if (!row) return res.status(404).json({ success: false, message: "MDCC entry not found" });

    const fields = [
      "mdcc_no",
      "mdcc_date",
      "project_details",
      "rfb_details",
      "ca_no",
      "bbu_ref_no",
      "po_no",
      "loa_no",
      "contractor_name",
      "contractor_address",
      "bbu_sl_no",
      "bbu_item_sl_no",
      "item_material_description",
      "uom",
      "mt",
      "qty_as_per_bbu",
      "mdcc_issued_till_date",
      "mdcc_issued_for",
      "manufacturer",
      "inspect",
      "remarks",
      "mdcc_items",
      "inspected_by",
      "mandays",
      "uploaded_files",
    ];

    fields.forEach((f) => {
      if (req.body[f] !== undefined) row[f] = req.body[f];
    });

    await row.save();
    return res.status(200).json({ success: true, data: row, message: "MDCC entry updated" });
  } catch (err) {
    console.error("editQaMdcc error:", err);
    return res.status(500).json({ success: false, message: "Failed to update MDCC entry" });
  }
};

exports.deleteQaMdcc = async (req, res) => {
  try {
    const { mdcc_id } = req.params;
    const row = await QaMdcc.findByPk(mdcc_id);
    if (!row) return res.status(404).json({ success: false, message: "MDCC entry not found" });
    await row.destroy();
    return res.status(200).json({ success: true, message: "MDCC entry deleted" });
  } catch (err) {
    console.error("deleteQaMdcc error:", err);
    return res.status(500).json({ success: false, message: "Failed to delete MDCC entry" });
  }
};

// ── QA Summary ──────────────────────────────────────────────────────────
exports.getQaSummary = async (req, res) => {
  try {
    const projects = await QaRegisteredProject.findAll({
      include: [
        {
          model: QaBbu,
          as: "bbus",
          required: false,
        },
        {
          model: QaMdcc,
          as: "mdccs",
          required: false,
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    let totalBbu = 0;
    let totalMdcc = 0;
    const counts = projects.map((p) => {
      const bbuCount = (p.bbus || []).length;
      const mdccCount = (p.mdccs || []).length;
      totalBbu += bbuCount;
      totalMdcc += mdccCount;
      return {
        project_name: p.project_name,
        bbu_count: bbuCount,
        mdcc_count: mdccCount,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        total_projects: projects.length,
        total_bbu: totalBbu,
        total_mdcc: totalMdcc,
        per_project: counts,
      },
    });
  } catch (err) {
    console.error("getQaSummary error:", err);
    return res.status(500).json({ success: false, message: "Failed to load QA summary" });
  }
};
