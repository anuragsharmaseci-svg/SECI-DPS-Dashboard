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

async function requireDeptHeadAccess(req, res, next) {
  let deptId = getDeptId(req);
  if (!deptId) {
    const deptNames = getDeptNamesFromPath(req.path);
    if (!deptNames.length) return next();
    try {
      const dept = await DeptMaster.findOne({ where: { dept_name: deptNames, is_active: true }, attributes: ["dept_id"] });
      deptId = dept?.dept_id || null;
    } catch (err) {
      return res.status(500).json({ error: "Failed to resolve department" });
    }
    if (!deptId) return res.status(403).json({ error: "Access denied: department not found" });
  }

  let user = req.user || null;
  if (!user) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const token = authHeader.split(" ")[1];
    try {
      user = jwt.verify(token, SECRET_KEY);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  if (user.role === "admin") return next();

  try {
    const access = await UserEditAccess.findOne({ where: { user_id: user.user_id, dept_id: deptId } });
    const level = String(access?.access_level || "").trim().toLowerCase();
    const allowHead = level === "head";
    if (!allowHead) return res.status(403).json({ error: "Access denied: head access required" });
    return next();
  } catch (err) {
    return res.status(500).json({ error: "Failed to check head access" });
  }
}

module.exports = { requireDeptHeadAccess };
