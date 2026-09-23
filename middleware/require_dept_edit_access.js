const jwt = require("jsonwebtoken");
const { UserEditAccess, DeptMaster } = require("../models").models;

const SECRET_KEY = process.env.JWT_SECRET;

function getDeptId(req) {
  if (req.params && req.params.dept_id) return req.params.dept_id;
  if (req.body && req.body.dept_id) return req.body.dept_id;
  if (req.query && req.query.dept_id) return req.query.dept_id;
  return null;
}

function getDeptNamesFromPath(pathname) {
  const path = String(pathname || "").toLowerCase();
  if (path.startsWith("/bd/")) return ["Business Development"];
  if (path.startsWith("/pmc/")) return ["PMC"];
  if (path.startsWith("/contracts/")) return ["Contracts & Procurement"];
  if (path.startsWith("/reia/")) return ["REIA"];
  if (path.startsWith("/om/")) return ["O&M"];
  if (path.startsWith("/qa/")) return ["QA"];
  if (path.startsWith("/energy/")) return ["Energy Management", "Energy Mangement"];
  return [];
}

async function requireDeptEditAccess(req, res, next) {
  const method = String(req.method || "").toUpperCase();
  const readOnlyMethods = ["GET", "HEAD", "OPTIONS"];
  if (readOnlyMethods.indexOf(method) !== -1) {
    return next();
  }

  let deptId = getDeptId(req);
  if (!deptId) {
    const deptNames = getDeptNamesFromPath(req.path);
    if (!deptNames.length) {
      return next();
    }

    try {
      const dept = await DeptMaster.findOne({
        where: { dept_name: deptNames, is_active: true },
        attributes: ["dept_id"],
      });
      deptId = dept?.dept_id || null;
    } catch (err) {
      return res.status(500).json({ error: "Failed to resolve department" });
    }

    if (!deptId) {
      return res.status(403).json({ error: "Access denied: department not found" });
    }
  }

  let user = req.user || null;
  if (!user) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ error: "Missing or invalid Authorization header" });
    }

    const token = authHeader.split(" ")[1];
    try {
      user = jwt.verify(token, SECRET_KEY);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  if (user.role === "admin") {
    return next();
  }

  try {
    const access = await UserEditAccess.findOne({
      where: { user_id: user.user_id, dept_id: deptId },
    });

    const level = String(access?.access_level || "").trim().toLowerCase();
    // view: read-only (GET allowed, any mutation blocked)
    // edit: can edit/upload/add/delete but NOT register project
    // head: full access including register project
    const isHead = level === 'head';
    const isEdit = level === 'edit';
    const isView = level === 'view';

    // Block register project for non-head users
    if (req.path && req.path.includes('/qa/project/add') && !isHead) {
      return res.status(403).json({ error: 'Access denied: head access required to register QA project' });
    }

    // For view users: block any mutation (POST/PUT/DELETE) on QA routes
    if (isView && req.path && req.path.startsWith('/qa/') && !readOnlyMethods.includes(method)) {
      return res.status(403).json({ error: 'Access denied: view access is read-only' });
    }

    // For edit users: allow mutations except register project (already blocked above)
    if (isEdit && !readOnlyMethods.includes(method)) {
      return next();
    }

    if (isHead && !readOnlyMethods.includes(method)) {
      return next();
    }

    if (!isHead && !isEdit && !isView) {
      return res.status(403).json({ error: "Access denied: edit not allowed" });
    }

    return next();
  } catch (err) {
    return res.status(500).json({ error: "Failed to check edit access" });
  }
}

async function resolveUserDeptAccessLevel(user, deptId) {
  if (!user || !deptId) return 'none';
  if (user.role === 'admin') return 'head';
  try {
    const access = await UserEditAccess.findOne({
      where: { user_id: user.user_id, dept_id: deptId },
    });
    const rawLevel = String(access?.access_level || '').trim().toLowerCase();
    if (rawLevel === 'view' || rawLevel === 'edit' || rawLevel === 'head') return rawLevel;
    return access?.can_edit === true ? 'edit' : 'view';
  } catch (e) {
    return 'none';
  }
}

module.exports = {
  requireDeptEditAccess,
  resolveUserDeptAccessLevel,
};
