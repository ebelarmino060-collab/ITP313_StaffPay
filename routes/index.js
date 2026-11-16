/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
/*
 * StaffPay routes. Roles: admin (full access), hr (attendance / leave / payroll),
 * employee (self-service under /my). Every POST form carries a CSRF token.
 */
import express from "express";
import { requireAuth, requireRole, requireEmployee } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { imageUpload, textUpload } from "../middleware/upload.js";

import { loginPage, loginUser, logoutUser } from "../controllers/authController.js";
import { dashboard } from "../controllers/dashboardController.js";
import * as notifications from "../controllers/notificationController.js";
import * as profile from "../controllers/profileController.js";
import * as employees from "../controllers/employeeController.js";
import * as organization from "../controllers/organizationController.js";
import * as attendance from "../controllers/attendanceController.js";
import * as schedules from "../controllers/scheduleController.js";
import * as leaves from "../controllers/leaveController.js";
import * as payroll from "../controllers/payrollController.js";
import * as payslips from "../controllers/payslipController.js";
import * as reports from "../controllers/reportController.js";
import * as admin from "../controllers/adminController.js";
import * as my from "../controllers/myController.js";
import * as imports from "../controllers/importController.js";
import * as analytics from "../controllers/analyticsController.js";

const router = express.Router();
const management = requireRole("admin", "hr");
const adminOnly = requireRole("admin");

// ---- Public
router.get("/login", loginPage);
router.post("/login", rateLimit({ max: 10 }), loginUser);
router.post("/logout", logoutUser);
router.get("/logout", logoutUser);

// ---- Every signed-in user
router.use(requireAuth);
router.get("/", dashboard);
router.get("/notifications.json", notifications.list);
router.post("/notifications/read-all", notifications.markAllRead);
router.post("/notifications/:id/read", notifications.markRead);

router.get("/profile", profile.show);
router.post("/profile", profile.update);
router.post("/profile/photo", ...imageUpload("photo", "photos"), profile.photo);
router.post("/profile/password", profile.password);

// Payslips (access checked in the controller: own + released, or management).
router.get("/payslips/:id", payslips.show);
router.get("/payslips/:id/pdf", payslips.pdf);

// ---- Employee self-service (users with a linked employee record)
router.get("/my/attendance", requireEmployee, my.attendance);
router.post("/my/attendance/time-in", requireEmployee, rateLimit({ max: 20 }), my.timeIn);
router.post("/my/attendance/time-out", requireEmployee, rateLimit({ max: 20 }), my.timeOut);
router.post("/my/corrections", requireEmployee, my.requestCorrection);
router.get("/my/schedule", requireEmployee, my.schedule);
router.get("/my/leaves", requireEmployee, my.leaves);
router.get("/my/leaves/preview.json", requireEmployee, my.previewLeave);
router.post("/my/leaves", requireEmployee, my.fileLeave);
router.post("/my/leaves/:id/cancel", requireEmployee, my.cancelLeave);
router.get("/my/payslips", requireEmployee, my.payslips);
router.get("/my/payslips/:id", requireEmployee, payslips.show);

// ---- Administrator + HR / Payroll
router.get("/employees", management, employees.index);
router.get("/employees/:id", management, employees.show);

// Attendance TXT import: upload -> preview -> commit
router.get("/attendance/import", management, imports.index);
router.post("/attendance/import", management, ...textUpload("file"), imports.upload);
router.get("/attendance/import/sample.txt", management, imports.sample);
router.get("/attendance/import/template.txt", management, imports.template);
router.post("/attendance/import/formats", management, imports.storeFormat);
router.post("/attendance/import/formats/test", management, imports.testFormat);
router.post("/attendance/import/formats/:id/update", management, imports.updateFormat);
router.post("/attendance/import/formats/:id/delete", management, imports.destroyFormat);
router.get("/attendance/import/:id", management, imports.show);
router.get("/attendance/import/:id/file", management, imports.file);
router.post("/attendance/import/:id/commit", management, imports.commit);
router.post("/attendance/import/:id/cancel", management, imports.cancel);

// Attendance analytics (weekly / monthly / yearly)
router.get("/attendance/analytics", management, analytics.index);
router.get("/attendance/analytics/export", management, analytics.exportAnalytics);

// Payslips: list per finalized payroll + bulk ZIP
router.get("/payslips", management, payslips.index);
router.get("/payslips/zip/:payrollId", management, payslips.zip);

router.get("/attendance", management, attendance.daily);
router.get("/attendance/records", management, attendance.records);
router.get("/attendance/summary", management, attendance.summary);
router.get("/attendance/overtime", management, attendance.overtime);
router.get("/attendance/corrections", management, attendance.corrections);
router.post("/attendance", management, attendance.store);
router.post("/attendance/mark-absences", management, attendance.markAbsences);
router.post("/attendance/corrections/:id/review", management, attendance.reviewCorrection);
router.post("/attendance/:id/update", management, attendance.update);
router.post("/attendance/:id/delete", management, attendance.destroy);
router.post("/attendance/:id/overtime", management, attendance.reviewOvertime);

router.get("/schedules", management, schedules.calendar);
router.get("/schedules/assignments", management, schedules.assignments);
router.post("/schedules", management, schedules.assign);
router.get("/schedules/shifts", management, schedules.shifts);
router.post("/schedules/shifts", management, schedules.storeShift);
router.post("/schedules/shifts/:id/update", management, schedules.updateShift);
router.post("/schedules/shifts/:id/delete", management, schedules.destroyShift);
router.get("/schedules/holidays", management, schedules.holidays);
router.post("/schedules/:id/update", management, schedules.updateSchedule);
router.post("/schedules/:id/delete", management, schedules.destroySchedule);

router.get("/leaves", management, leaves.requests);
router.post("/leaves/:id/review", management, leaves.review);
router.get("/leaves/balances", management, leaves.balances);
router.post("/leaves/balances/:id/update", management, leaves.updateBalance);
router.get("/leaves/history/:id", management, leaves.history);

router.get("/payroll", management, payroll.index);
router.post("/payroll", management, payroll.store);
router.get("/payroll/salary", management, payroll.salary);
router.post("/payroll/details/:id/update", management, payroll.updateDetail);
router.get("/payroll/:id", management, payroll.show);
router.post("/payroll/:id/update", management, payroll.update);
router.post("/payroll/:id/delete", management, payroll.destroy);
router.post("/payroll/:id/calculate", management, payroll.calculate);
router.post("/payroll/:id/approve", management, payroll.approve);
router.post("/payroll/:id/mark-paid", management, payroll.markPaid);

router.get("/reports", management, reports.index);
router.get("/reports/export", management, reports.exportReport);

// ---- Administrator only
router.post("/employees", adminOnly, ...imageUpload("photo", "photos"), employees.store);
router.post("/employees/:id/update", adminOnly, ...imageUpload("photo", "photos"), employees.update);
router.post("/employees/:id/delete", adminOnly, employees.destroy);
router.post("/employees/:id/account", adminOnly, employees.toggleAccount);

router.get("/organization", adminOnly, organization.index);
router.post("/organization/departments", adminOnly, organization.storeDepartment);
router.post("/organization/departments/:id/update", adminOnly, organization.updateDepartment);
router.post("/organization/departments/:id/delete", adminOnly, organization.destroyDepartment);
router.post("/organization/positions", adminOnly, organization.storePosition);
router.post("/organization/positions/:id/update", adminOnly, organization.updatePosition);
router.post("/organization/positions/:id/delete", adminOnly, organization.destroyPosition);

router.post("/schedules/holidays", adminOnly, schedules.storeHoliday);
router.post("/schedules/holidays/:id/update", adminOnly, schedules.updateHoliday);
router.post("/schedules/holidays/:id/delete", adminOnly, schedules.destroyHoliday);

router.post("/payroll/:id/reopen", adminOnly, payroll.reopen);
router.post("/payroll/salary/:kind", adminOnly, payroll.storeSalary);
router.post("/payroll/salary/:kind/:id/update", adminOnly, payroll.updateSalary);
router.post("/payroll/salary/:kind/:id/delete", adminOnly, payroll.destroySalary);

router.get("/users", adminOnly, admin.users);
router.post("/users", adminOnly, admin.storeUser);
router.post("/users/:id/update", adminOnly, admin.updateUser);
router.post("/users/:id/delete", adminOnly, admin.destroyUser);
router.get("/settings", adminOnly, admin.settings);
router.post("/settings", adminOnly, admin.updateSettings);
router.post("/settings/logo", adminOnly, ...imageUpload("logo", "branding"), admin.uploadLogo);
router.get("/audit-logs", adminOnly, admin.auditLogs);

export default router;
