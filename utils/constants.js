export const ROLE_LABELS = { admin: 'Administrator', hr: 'HR / Payroll', employee: 'Employee' };

export const ATTENDANCE_STATUS = {
  present: { label: 'Present', tone: 'success' },
  late: { label: 'Late', tone: 'warning' },
  half_day: { label: 'Half-day', tone: 'orange' },
  absent: { label: 'Absent', tone: 'danger' },
  on_leave: { label: 'On Leave', tone: 'info' },
  rest_day: { label: 'Rest Day', tone: 'muted' },
  awaiting: { label: 'Not yet in', tone: 'neutral' },
  no_record: { label: 'No record', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'neutral' },
};

export const REQUEST_STATUS = {
  pending: { label: 'Pending', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  none: { label: '—', tone: 'muted' },
};

export const PAYROLL_STATUS = {
  draft: { label: 'Draft', tone: 'muted' },
  calculated: { label: 'Calculated', tone: 'info' },
  approved: { label: 'Finalized', tone: 'success' },
  paid: { label: 'Paid', tone: 'navy' },
};

export const EMPLOYMENT_STATUS = {
  active: { label: 'Active', tone: 'success' },
  probationary: { label: 'Probationary', tone: 'info' },
  on_leave: { label: 'On Leave', tone: 'warning' },
  resigned: { label: 'Resigned', tone: 'muted' },
  terminated: { label: 'Terminated', tone: 'danger' },
};

export const EMPLOYMENT_TYPE_LABELS = { full_time: 'Full-time', part_time: 'Part-time', contractual: 'Contractual', seasonal: 'Seasonal' };
export const LEAVE_TYPE_LABELS = { vacation: 'Vacation Leave', sick: 'Sick Leave', emergency: 'Emergency Leave', unpaid: 'Unpaid Leave' };
export const DEDUCTION_TYPE_LABELS = { loan: 'Loan', cash_advance: 'Cash Advance', uniform: 'Uniform', meal: 'Meal', other: 'Other' };

export const WEEKDAYS = [
  { value: 1, short: 'Mon', label: 'Monday' }, { value: 2, short: 'Tue', label: 'Tuesday' },
  { value: 3, short: 'Wed', label: 'Wednesday' }, { value: 4, short: 'Thu', label: 'Thursday' },
  { value: 5, short: 'Fri', label: 'Friday' }, { value: 6, short: 'Sat', label: 'Saturday' },
  { value: 7, short: 'Sun', label: 'Sunday' },
];

export const STATUS_MAPS = {
  attendance: ATTENDANCE_STATUS, request: REQUEST_STATUS, payroll: PAYROLL_STATUS, employment: EMPLOYMENT_STATUS,
};

/** Option lists for <select> elements, exposed to every view as `opts`. */
const toOptions = (obj) => Object.entries(obj).map(([value, v]) => ({ value, label: typeof v === 'string' ? v : v.label }));
export const OPTIONS = {
  roles: toOptions(ROLE_LABELS),
  employmentStatus: toOptions(EMPLOYMENT_STATUS),
  employmentTypes: toOptions(EMPLOYMENT_TYPE_LABELS),
  leaveTypes: toOptions(LEAVE_TYPE_LABELS),
  deductionTypes: toOptions(DEDUCTION_TYPE_LABELS),
  requestStatus: toOptions(REQUEST_STATUS).filter((o) => o.value !== 'none'),
  payrollStatus: toOptions(PAYROLL_STATUS),
  attendanceStatus: ['present', 'late', 'half_day', 'absent', 'on_leave', 'rest_day'].map((value) => ({ value, label: ATTENDANCE_STATUS[value].label })),
  weekdays: WEEKDAYS,
  genders: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }],
};
