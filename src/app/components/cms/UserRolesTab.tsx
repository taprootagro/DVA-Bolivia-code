import { useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { isDeveloperMode } from "../../utils/developerMode";
import { readXlsxRows } from "../../utils/readXlsxRows";
import { edgeFnAuth } from "./edgeFnAuth";
import type { CmsTabProps } from "./cmsTab";

const UUID_RE_CLIENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 模板里的示例 UUID；上传导入时会跳过，避免误写入。 */
const ROLE_IMPORT_EXAMPLE_UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function escapeCsvCell(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 表头：取「（」或「(」前的主 key，再压成与导入别名一致的 stem（如 user_id → userid）。 */
function roleImportHeaderStem(cell: unknown): string {
  let s = String(cell ?? "").trim().toLowerCase();
  for (const sep of ["（", "("]) {
    const i = s.indexOf(sep);
    if (i >= 0) {
      s = s.slice(0, i).trim();
      break;
    }
  }
  return s.replace(/_/g, "").replace(/\s+/g, "");
}

/** First spreadsheet row: need user_id (aliases), optional content_role / app_role. */
function detectRoleImportColumns(headerRow: unknown[]): { userIdx: number; contentIdx: number; appIdx: number } | null {
  let userIdx = -1;
  let contentIdx = -1;
  let appIdx = -1;
  const userKeys = new Set(["userid", "uuid", "user"]);
  const contentKeys = new Set(["contentrole", "cmsrole"]);
  const appKeys = new Set(["approle", "storerole"]);
  headerRow.forEach((cell, i) => {
    const k = roleImportHeaderStem(cell);
    if (userKeys.has(k)) userIdx = i;
    else if (contentKeys.has(k)) contentIdx = i;
    else if (appKeys.has(k)) appIdx = i;
  });
  if (userIdx < 0) return null;
  return { userIdx, contentIdx, appIdx };
}

function parseExcelContentRoleCell(raw: unknown): "none" | "editor" | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "none" || s === "clear" || s === "revoke" || s === "无" || s === "無") return "none";
  if (s === "editor" || s === "编辑" || s === "編輯") return "editor";
  return null;
}

function parseExcelAppRoleCell(raw: unknown): "farmer" | "distributor" | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  if (s === "farmer" || s === "农户" || s === "農戶") return "farmer";
  if (s === "distributor" || s === "门店" || s === "分销商") return "distributor";
  return null;
}

export function UserRolesTab({
  workingConfig,
  ct,
  contentRole,
}: Pick<CmsTabProps, "workingConfig" | "ct"> & { contentRole: string | null }) {
  const roleExcelInputRef = useRef<HTMLInputElement>(null);
  const [roleApplyBusy, setRoleApplyBusy] = useState(false);
  const [roleBulkResult, setRoleBulkResult] = useState<string | null>(null);
  const [roleSingleUserId, setRoleSingleUserId] = useState("");
  const [roleSingleContent, setRoleSingleContent] = useState<"" | "none" | "editor">("");
  const [roleSingleApp, setRoleSingleApp] = useState<"" | "farmer" | "distributor">("");

  const postUserRoleRows = async (
    rows: Array<Record<string, string>>,
  ): Promise<Array<{ userId: string; ok: boolean; error?: string }> | null> => {
    const auth = await edgeFnAuth(workingConfig);
    if (!auth) {
      alert(ct("messages.configure_server_connection_first", "请先配置服务器连接", "Configure server connection first"));
      return null;
    }
    if (!auth.token) {
      alert(ct("messages.sign_in_with_supabase_first", "请先登录 Supabase 会话", "Sign in with Supabase first"));
      return null;
    }
    const res = await fetch(`${auth.base}/admin/user-roles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: auth.anon,
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ rows }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; results?: Array<{ userId: string; ok: boolean; error?: string }> };
    if (!res.ok) {
      alert(ct(`请求失败：${data?.error || res.statusText}`, `Request failed: ${data?.error || res.statusText}`));
      return null;
    }
    return data.results || [];
  };

  const applyUserRoleBatches = async (parsedRows: Array<Record<string, string>>) => {
    if (parsedRows.length === 0) {
      setRoleBulkResult(ct("messages.no_valid_rows_to_submit", "没有可提交的有效行", "No valid rows to submit"));
      return;
    }
    setRoleApplyBusy(true);
    setRoleBulkResult(null);
    try {
      let ok = 0;
      let fail = 0;
      const errLines: string[] = [];
      for (let i = 0; i < parsedRows.length; i += 200) {
        const chunk = parsedRows.slice(i, i + 200);
        const results = await postUserRoleRows(chunk);
        if (!results) {
          setRoleBulkResult(ct("messages.batch_apply_aborted", "批量应用已中断", "Batch apply aborted"));
          return;
        }
        for (const r of results) {
          if (r.ok) ok++;
          else {
            fail++;
            if (errLines.length < 40) errLines.push(`${r.userId}: ${r.error || "?"}`);
          }
        }
      }
      setRoleBulkResult(
        ct(`完成：成功 ${ok}，失败 ${fail}`, `Done: ${ok} ok, ${fail} failed`) +
          (errLines.length ? `\n${errLines.join("\n")}` : ""),
      );
    } finally {
      setRoleApplyBusy(false);
    }
  };

  const downloadDistributorsCsv = async () => {
    const auth = await edgeFnAuth(workingConfig);
    if (!auth) {
      alert(ct("messages.configure_server_connection_first", "请先配置服务器连接", "Configure server connection first"));
      return;
    }
    if (!auth.token) {
      alert(ct("messages.sign_in_with_supabase_first", "请先登录 Supabase 会话", "Sign in with Supabase first"));
      return;
    }
    setRoleApplyBusy(true);
    try {
      const res = await fetch(`${auth.base}/admin/distributors`, {
        headers: { apikey: auth.anon, Authorization: `Bearer ${auth.token}` },
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> };
      if (!res.ok || !data?.ok) {
        alert(ct(`请求失败：${data?.error || res.statusText}`, `Request failed: ${data?.error || res.statusText}`));
        return;
      }
      const rows = data.rows || [];
      const header = [
        ct("messages.user_id_required_supabase_auth_uuid", "user_id（必填·勿改·Supabase Auth UUID）", "user_id (required · Supabase Auth UUID)"),
        ct("messages.display_name_read_only", "display_name（只读）", "display_name (read-only)"),
        ct("messages.phone_read_only", "phone（只读）", "phone (read-only)"),
        ct("messages.content_role_optional_lowercase_none_or_editor_no", "content_role（选填·英文 none 或 editor·勿用对勾）", "content_role (optional · lowercase none or editor · no checkmarks)"),
        ct("messages.app_role_optional_lowercase_farmer_or_distributor_no", "app_role（选填·英文 farmer 或 distributor·勿用对勾）", "app_role (optional · lowercase farmer or distributor · no checkmarks)"),
        ct("messages.updated_at_read_only", "updated_at（只读）", "updated_at (read-only)"),
      ];
      const legend = ct("messages.how_to_edit_change_only_content_role_and", "填写说明：若只改角色，请编辑「content_role」「app_role」两列；必须填英文小写单词 none / editor / farmer / distributor，不要用 √、不要写「是」或中文角色名。user_id 列请勿手改。", "How to edit: change only content_role and app_role using lowercase English (none, editor, farmer, distributor). No checkmarks. Do not edit user_id.");
      const lines = [
        header.map(escapeCsvCell).join(","),
        [escapeCsvCell(legend), "", "", "", "", ""].join(","),
        ...rows.map((r) => header.map((_, hi) => {
          const keys = ["user_id", "display_name", "phone", "content_role", "app_role", "updated_at"];
          return escapeCsvCell(r[keys[hi]]);
        }).join(",")),
      ];
      const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `distributors-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      setRoleApplyBusy(false);
    }
  };

  const downloadRoleImportTemplate = () => {
    const h0 = ct("messages.user_id_required_uuid_from_supabase_auth", "user_id（必填·Supabase Auth 里用户的 UUID）", "user_id (required · UUID from Supabase Auth)");
    const h1 = ct("messages.content_role_optional_lowercase_none_or_editor_no", "content_role（选填·英文 none 或 editor·勿用对勾）", "content_role (optional · lowercase none or editor · no checkmarks)");
    const h2 = ct("messages.app_role_optional_lowercase_farmer_or_distributor_no", "app_role（选填·英文 farmer 或 distributor·勿用对勾）", "app_role (optional · lowercase farmer or distributor · no checkmarks)");
    const lines = [
      [escapeCsvCell(h0), escapeCsvCell(h1), escapeCsvCell(h2)].join(","),
      [
        escapeCsvCell(
          ct("messages.note_column_a_must_be_a_uuid_not", "（说明·勿在 A 列填中文当 UUID）三列均填英文小写：none / editor / farmer / distributor；不要用 √、不要用中文代替。none=撤内容权限；editor=内容编辑；farmer=农户壳；distributor=门店壳。某一格留空=上传时不改该项。", "(Note) Column A must be a UUID, not Chinese text. Use lowercase English: none / editor / farmer / distributor — no checkmarks. Blank cell = leave that field unchanged on upload."),
        ),
        "",
        "",
      ].join(","),
      [
        escapeCsvCell(
          ct("messages.next_row_is_an_example_delete_it_or", "下一行为示例：请删除该行或把 UUID 换成真实用户。若仍保留示例 UUID，上传时系统会自动忽略该行。", "Next row is an example — delete it or replace the UUID. The sample UUID is ignored on upload if left unchanged."),
        ),
        "",
        "",
      ].join(","),
      [ROLE_IMPORT_EXAMPLE_UUID, "editor", "distributor"].map(escapeCsvCell).join(","),
    ];
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "role-import-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleRoleExcelFile = async (file: File | undefined) => {
    if (!file) return;
    setRoleBulkResult(null);
    try {
      const matrix = await readXlsxRows(file);
      if (!matrix || matrix.length < 2) {
        alert(ct("messages.spreadsheet_is_empty_or_has_no_data_rows", "表格为空或没有数据行", "Spreadsheet is empty or has no data rows"));
        return;
      }
      const header = matrix[0] as unknown[];
      const idx = detectRoleImportColumns(header);
      if (!idx) {
        alert(
          ct("messages.first_row_must_include_a_user_id_column", "首行需包含 user_id 列（表头可带中文说明，系统取「（」或「(」前的英文列名识别）。", "First row must include a user_id column (Chinese hints in headers are OK; we use the English part before '(')."),
        );
        return;
      }
      const out: Array<Record<string, string>> = [];
      for (let r = 1; r < matrix.length; r++) {
        const row = matrix[r] as unknown[];
        const uid = String(row[idx.userIdx] ?? "").trim();
        if (!UUID_RE_CLIENT.test(uid)) continue;
        if (uid === ROLE_IMPORT_EXAMPLE_UUID) continue;
        const contentRole = idx.contentIdx >= 0 ? parseExcelContentRoleCell(row[idx.contentIdx]) : null;
        const appRole = idx.appIdx >= 0 ? parseExcelAppRoleCell(row[idx.appIdx]) : null;
        const rec: Record<string, string> = { userId: uid };
        if (contentRole !== null) rec.contentRole = contentRole;
        if (appRole !== null) rec.appRole = appRole;
        if (!rec.contentRole && !rec.appRole) continue;
        out.push(rec);
      }
      if (out.length === 0) {
        alert(
          ct("messages.no_valid_rows_need_a_valid_uuid_and", "未解析到有效行（需合法 UUID，且至少填写 content_role 或 app_role 之一）", "No valid rows (need a valid UUID and at least content_role or app_role)"),
        );
        return;
      }
      await applyUserRoleBatches(out);
    } catch (e: any) {
      alert(ct(`读取表格失败：${e?.message || e}`, `Failed to read spreadsheet: ${e?.message || e}`));
    }
  };

  const applySingleUserRole = async () => {
    const uid = roleSingleUserId.trim();
    if (!UUID_RE_CLIENT.test(uid)) {
      alert(ct("messages.user_id_must_be_a_valid_uuid", "用户 ID 须为合法 UUID", "User ID must be a valid UUID"));
      return;
    }
    const rec: Record<string, string> = { userId: uid };
    if (roleSingleContent) rec.contentRole = roleSingleContent;
    if (roleSingleApp) rec.appRole = roleSingleApp;
    if (!rec.contentRole && !rec.appRole) {
      alert(ct("messages.select_at_least_one_role_field_to_write", "请至少选择一项要写入的角色", "Select at least one role field to write"));
      return;
    }
    await applyUserRoleBatches([rec]);
  };

  return (
    <div className="space-y-4">
      {isDeveloperMode() && contentRole !== "admin" && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-[11px] text-blue-900">
          {ct("messages.dev_mode_this_entry_is_visible_if_your", "开发者模式：此处入口已显示。若当前账号在数据库中不是 content_role=admin，调用列表/写入接口会返回 403，属预期。生产环境仅超级管理员可见此页。", "Dev mode: this entry is visible. If your DB content_role is not admin, list/write APIs return 403 — expected. In production, only content super-admins see this page.")}
        </div>
      )}
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-[11px] text-amber-900 space-y-1">
        <p>
          {ct("messages.writes_user_profiles_by_supabase_auth_user_uuid", "按 Supabase Auth 用户 UUID 写入 user_profiles：content_role 为 none 或 editor；app_role 为 farmer 或 distributor。此页不能授予 content admin。", "Writes user_profiles by Supabase Auth user UUID: content_role is none or editor; app_role is farmer or distributor. This page cannot grant content admin.")}
        </p>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">{ct("messages.distributor_list", "分销商列表", "Distributor list")}</h3>
        <p className="text-xs text-gray-500">
          {ct("messages.exports_distributors_max_5000_row_1_headers_with", "导出当前 app_role 为 distributor 的用户（最多 5000 条）。CSV 第 1 行为带说明的表头，第 2 行为填写规则；改角色时请填英文 none / editor / farmer / distributor，勿用对勾。", "Exports distributors (max 5000). Row 1: headers with hints; row 2: how to fill. Use lowercase English for roles — no checkmarks.")}
        </p>
        <button
          type="button"
          disabled={roleApplyBusy}
          onClick={() => void downloadDistributorsCsv()}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm hover:bg-emerald-700 disabled:opacity-50"
        >
          {roleApplyBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          {ct("messages.download_csv", "下载 CSV", "Download CSV")}
        </button>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">{ct("messages.excel_bulk_import", "批量导入 Excel", "Excel bulk import")}</h3>
        <p className="text-xs text-gray-500">
          {ct("messages.headers_must_resolve_to_user_id_content_role", "表头须能识别 user_id、content_role、app_role（可与下载文件一样带中文说明）。单元格请填英文小写：none、editor、farmer、distributor；不要用 √。留空表示该项不修改。每次最多 200 行，超出自动分批。", "Headers must resolve to user_id, content_role, app_role (Chinese hints OK). Values: lowercase none, editor, farmer, distributor — no checkmarks. Blank = skip field. Batches of 200.")}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={downloadRoleImportTemplate}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            {ct("messages.download_template", "下载导入模板", "Download template")}
          </button>
          <button
            type="button"
            disabled={roleApplyBusy}
            onClick={() => roleExcelInputRef.current?.click()}
            className="px-3 py-2 text-sm bg-gray-800 text-white rounded-lg hover:bg-gray-900 disabled:opacity-50"
          >
            {ct("messages.upload_excel", "上传 Excel", "Upload Excel")}
          </button>
        </div>
      </div>
      <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
        <h3 className="text-sm font-semibold text-gray-800">{ct("messages.single_user", "单个用户", "Single user")}</h3>
        <input
          type="text"
          value={roleSingleUserId}
          onChange={(e) => setRoleSingleUserId(e.target.value)}
          placeholder={ct("messages.user_uuid", "用户 UUID", "User UUID")}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-xs"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">content_role</label>
            <select
              value={roleSingleContent}
              onChange={(e) => setRoleSingleContent(e.target.value as "" | "none" | "editor")}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="">{ct("messages.leave_unchanged", "不修改", "Leave unchanged")}</option>
              <option value="none">none</option>
              <option value="editor">editor</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">app_role</label>
            <select
              value={roleSingleApp}
              onChange={(e) => setRoleSingleApp(e.target.value as "" | "farmer" | "distributor")}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="">{ct("messages.leave_unchanged", "不修改", "Leave unchanged")}</option>
              <option value="farmer">farmer</option>
              <option value="distributor">distributor</option>
            </select>
          </div>
        </div>
        <button
          type="button"
          disabled={roleApplyBusy}
          onClick={() => void applySingleUserRole()}
          className="w-full py-2.5 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {roleApplyBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {ct("messages.apply", "应用", "Apply")}
        </button>
      </div>
      {roleBulkResult ? (
        <pre className="text-[11px] bg-gray-50 border border-gray-200 rounded-lg p-3 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
          {roleBulkResult}
        </pre>
      ) : null}
      <input
        ref={roleExcelInputRef}
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handleRoleExcelFile(f);
        }}
      />
    </div>
  );
}

export default UserRolesTab;
