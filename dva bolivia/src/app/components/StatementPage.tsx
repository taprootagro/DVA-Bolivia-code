import { SecondaryView } from "./SecondaryView";
import { useLanguage } from "../hooks/useLanguage";
import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import {
  Plus, TrendingUp, TrendingDown, Wallet, Calendar, Tag,
  DollarSign, X, Edit, Trash2, Download, Upload, ChevronLeft, ChevronRight,
  Database, Shield, CheckCircle
} from "lucide-react";
import {
  saveTransactions as dbSaveTransactions,
  loadTransactions as dbLoadTransactions,
} from "../utils/db";
import { storageGet, storageSet } from "../utils/safeStorage";

interface StatementPageProps {
  onClose: () => void;
}

interface Transaction {
  id: string;
  type: "income" | "expense";
  amount: number;
  category: string;
  categoryKey: string;
  note: string;
  date: string;
  timestamp: number;
}

// ====== Toast 通知状态类型 ======
interface ToastState {
  message: string;
  type: 'success' | 'error';
  visible: boolean;
}

// ====== 存储常量 ======
const STORAGE_KEY = "accounting_transactions";
const BACKUP_KEY = "accounting_transactions_backup";
const SAVE_TIME_KEY = "accounting_last_saved";
const DATA_VERSION_KEY = "accounting_data_version";
const CURRENT_DATA_VERSION = 2;

// ====== 数据迁移：确保每条记录有 categoryKey ======
function migrateTransactions(raw: any[]): Transaction[] {
  return raw.map((tx: any) => ({
    id: tx.id || Date.now().toString() + Math.random().toString(36).slice(2),
    type: tx.type === "income" ? "income" : "expense",
    amount: typeof tx.amount === "number" ? tx.amount : parseFloat(tx.amount) || 0,
    category: tx.category || tx.categoryKey || "",
    categoryKey: tx.categoryKey || tx.category || "",
    note: tx.note || "",
    date: tx.date || new Date().toISOString().split("T")[0],
    timestamp: tx.timestamp || new Date(tx.date || Date.now()).getTime(),
  }));
}

// ====== 从 localStorage 加载，带备份回退 ======
function loadTransactionsFromStorage(): Transaction[] {
  // 先尝试主存储
  const mainData = storageGet(STORAGE_KEY);
  if (mainData) {
    try {
      const parsed = JSON.parse(mainData);
      if (Array.isArray(parsed) && parsed.length >= 0) {
        const migrated = migrateTransactions(parsed);
        // 确保按日期降序排列，跨版本迁移后顺序一致
        migrated.sort((a, b) => b.timestamp - a.timestamp);
        // 写入版本号
        storageSet(DATA_VERSION_KEY, CURRENT_DATA_VERSION.toString());
        return migrated;
      }
    } catch (e) {
      console.error("[Ledger] Main storage corrupted, trying backup:", e);
    }
  }

  // 主存储失败或为空，尝试备份
  const backupData = storageGet(BACKUP_KEY);
  if (backupData) {
    try {
      const parsed = JSON.parse(backupData);
      if (Array.isArray(parsed) && parsed.length > 0) {
        console.warn("[Ledger] Restored from backup!");
        const migrated = migrateTransactions(parsed);
        // 恢复到主存储
        storageSet(STORAGE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch (e) {
      console.error("[Ledger] Backup also corrupted:", e);
    }
  }

  return [];
}

// ====== 翻译回退 ======
const fallbackStrings: Record<string, string> = {
  exportData: 'Export Data',
  importData: 'Import Data',
  exportSuccess: 'Data exported successfully',
  importSuccess: 'Data imported successfully! {count} records loaded.',
  importFailed: 'Import failed: invalid file format',
  importConfirm: 'This will merge {count} records with your existing data. Continue?',
  recordCount: '{count} records',
  lastBackup: 'Last saved: {time}',
  dataManagement: 'Data Management',
  monthFilter: 'Filter by Month',
  allMonths: 'All',
};

export function StatementPage({ onClose }: StatementPageProps) {
  const { t } = useLanguage();
  const s = t.statement;

  // 带回退的翻译获取
  const ts = (key: string, replacements?: Record<string, string>): string => {
    let text = (s as any)[key] || fallbackStrings[key] || key;
    if (replacements) {
      Object.entries(replacements).forEach(([k, v]) => {
        text = text.replace(`{${k}}`, v);
      });
    }
    return text;
  };

  // ====== 惰性初始化：直接从 localStorage 读取，避免 useEffect 竞态 ======
  const [transactions, setTransactions] = useState<Transaction[]>(() =>
    loadTransactionsFromStorage()
  );

  // Dexie async hydration: if Dexie has newer/encrypted data, use it
  useEffect(() => {
    let cancelled = false;
    dbLoadTransactions().then((dexieData) => {
      if (cancelled || !dexieData || !Array.isArray(dexieData)) return;
      const migrated = migrateTransactions(dexieData);
      migrated.sort((a, b) => b.timestamp - a.timestamp);
      if (migrated.length > 0) {
        setTransactions(migrated);
      }
    }).catch(() => { /* Dexie unavailable, localStorage data already loaded */ });
    return () => { cancelled = true; };
  }, []);

  const [showAddForm, setShowAddForm] = useState(false);
  const [showDataPanel, setShowDataPanel] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [formData, setFormData] = useState({
    type: "expense" as "income" | "expense",
    amount: "",
    category: "",
    categoryKey: "",
    note: "",
    date: new Date().toISOString().split("T")[0],
  });

  // 月份筛选
  const [selectedMonth, setSelectedMonth] = useState<string>("all");

  // 文件输入引用
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Toast 通知
  const [toast, setToast] = useState<ToastState>({ message: '', type: 'success', visible: false });
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ message, type, visible: true });
    toastTimerRef.current = setTimeout(() => {
      setToast(prev => ({ ...prev, visible: false }));
    }, 2500);
  }, []);

  // 预设分类
  const incomeCategoryKeys = [
    "salary", "bonus", "investment", "partTime", "cropSales", "subsidy", "otherIncome"
  ] as const;
  const expenseCategoryKeys = [
    "seeds", "fertilizer", "pesticide", "equipment", "labor", "rent", "utilities", "transport", "food", "otherExpense"
  ] as const;

  const getCategoryLabel = (key: string): string => {
    return (s as any)[key] || key;
  };

  // ====== 安全保存：先备份旧数据，再写入新数据 ======
  const saveTransactions = useCallback((data: Transaction[]) => {
    // 1. 备份当前主存储（旧数据）到 backup key
    const currentMain = storageGet(STORAGE_KEY);
    if (currentMain) {
      storageSet(BACKUP_KEY, currentMain);
    }

    // 2. 写入新数据到主存储
    const json = JSON.stringify(data);
    const ok = storageSet(STORAGE_KEY, json);

    if (ok) {
      // 3. 记录保存时间
      storageSet(SAVE_TIME_KEY, new Date().toISOString());
      storageSet(DATA_VERSION_KEY, CURRENT_DATA_VERSION.toString());
    } else {
      // 写入失败时触发 Toast 告警
      console.error("[Ledger] Save failed! Data kept in memory only.");
      showToast(s.error + ': ' + (s.exportData || 'Save failed'), 'error');
    }

    // 4. Write to Dexie (encrypted, async, fire-and-forget)
    dbSaveTransactions(data).catch((e) =>
      console.warn('[Ledger] Dexie save failed (non-fatal):', e)
    );

    // 5. 更新 React 状态
    setTransactions(data);
  }, [showToast, s]);

  // 添加/编辑交易记录
  const handleSubmit = () => {
    const categoryKey = formData.categoryKey || formData.category;
    if (!formData.amount || !categoryKey) {
      alert(s.fillRequired);
      return;
    }

    const rawAmount = parseFloat(formData.amount);
    if (isNaN(rawAmount) || rawAmount <= 0) {
      alert(s.invalidAmount);
      return;
    }
    // 录入即按分四舍五入，避免 1.005 这类输入丢分
    const amount = Math.round(rawAmount * 100) / 100;

    const txDate = formData.date;

    if (editingTransaction) {
      const updated = transactions.map((tx) =>
        tx.id === editingTransaction.id
          ? {
              ...editingTransaction,
              type: formData.type,
              amount,
              category: formData.category || getCategoryLabel(categoryKey),
              categoryKey,
              note: formData.note,
              date: txDate,
              timestamp: new Date(txDate).getTime(),
            }
          : tx
      );
      saveTransactions(updated);
      setEditingTransaction(null);
    } else {
      const newTransaction: Transaction = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 10),
        type: formData.type,
        amount,
        category: formData.category || getCategoryLabel(categoryKey),
        categoryKey,
        note: formData.note,
        date: txDate,
        timestamp: new Date(txDate).getTime(),
      };
      saveTransactions([newTransaction, ...transactions]);
    }

    // 保存后自动切换到该记录所在月份，确保统计数字实时可见
    const txMonth = txDate.substring(0, 7);
    if (selectedMonth !== "all" && selectedMonth !== txMonth) {
      setSelectedMonth(txMonth);
    }

    setFormData({
      type: "expense",
      amount: "",
      category: "",
      categoryKey: "",
      note: "",
      date: new Date().toISOString().split("T")[0],
    });
    setShowAddForm(false);
  };

  // 删除交易记录
  const handleDelete = (id: string) => {
    if (confirm(s.confirmDelete)) {
      saveTransactions(transactions.filter((tx) => tx.id !== id));
    }
  };

  // 编辑交易记录
  const handleEdit = (transaction: Transaction) => {
    setEditingTransaction(transaction);
    setFormData({
      type: transaction.type,
      amount: transaction.amount.toString(),
      category: transaction.category,
      categoryKey: transaction.categoryKey || transaction.category,
      note: transaction.note,
      date: transaction.date,
    });
    setShowAddForm(true);
  };

  // ====== 数据导出：生成 JSON 文件下载 ======
  const handleExport = () => {
    const exportPayload = {
      version: CURRENT_DATA_VERSION,
      exportDate: new Date().toISOString(),
      appName: "TaprootAgro-Ledger",
      transactions,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledger_backup_${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(ts("exportSuccess"), 'success');
  };

  // ====== 数据导入：读取 JSON 文件并合并 ======
  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const content = ev.target?.result as string;
        const parsed = JSON.parse(content);

        let importedList: any[] = [];
        if (parsed.transactions && Array.isArray(parsed.transactions)) {
          importedList = parsed.transactions;
        } else if (Array.isArray(parsed)) {
          importedList = parsed;
        } else {
          alert(ts("importFailed"));
          return;
        }

        const migrated = migrateTransactions(importedList);

        if (migrated.length === 0) {
          alert(ts("importFailed"));
          return;
        }

        const confirmed = confirm(
          ts("importConfirm", { count: migrated.length.toString() })
        );
        if (!confirmed) return;

        // 合并：按 ID 去重，导入的数据不会覆盖已有记录
        const existingIds = new Set(transactions.map((tx) => tx.id));
        const newRecords = migrated.filter((tx) => !existingIds.has(tx.id));
        const merged = [...transactions, ...newRecords].sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
        );

        saveTransactions(merged);
        alert(ts("importSuccess", { count: newRecords.length.toString() }));
      } catch (err) {
        console.error("[Ledger] Import failed:", err);
        alert(ts("importFailed"));
      }
    };
    reader.readAsText(file);

    // 重置 input 以允许重复选择同一文件
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  // ====== 可用月份列表 ======
  const availableMonths = useMemo(() => {
    const months = new Set<string>();
    transactions.forEach((tx) => {
      const m = tx.date.substring(0, 7); // "YYYY-MM"
      months.add(m);
    });
    return Array.from(months).sort().reverse();
  }, [transactions]);

  // ====== 按月筛选的交易 ======
  const filteredTransactions = useMemo(() => {
    if (selectedMonth === "all") return transactions;
    return transactions.filter((tx) => tx.date.startsWith(selectedMonth));
  }, [transactions, selectedMonth]);

  // ====== 月份导航 ======
  const currentMonthIndex = availableMonths.indexOf(selectedMonth);

  const goToPrevMonth = () => {
    if (currentMonthIndex < availableMonths.length - 1) {
      setSelectedMonth(availableMonths[currentMonthIndex + 1]);
    }
  };
  const goToNextMonth = () => {
    if (currentMonthIndex > 0) {
      setSelectedMonth(availableMonths[currentMonthIndex - 1]);
    }
  };

  // ====== 计算统计（基于筛选后的数据） ======
  // 以「分」为整数单位累加，避免浮点累加误差（如 0.1+0.2）与 -0.00 红字，
  // 并保证「收入 − 支出 = 余额」在显示层始终自洽。
  const toCents = (n: number) => Math.round(n * 100);
  const fmtCents = (cents: number) => (cents / 100).toFixed(2);
  const statsCents = filteredTransactions.reduce(
    (acc, tx) => {
      if (tx.type === "income") acc.income += toCents(tx.amount);
      else acc.expense += toCents(tx.amount);
      return acc;
    },
    { income: 0, expense: 0 }
  );
  const balanceCents = statsCents.income - statsCents.expense;
  const incomeDisplay = fmtCents(statsCents.income);
  const expenseDisplay = fmtCents(statsCents.expense);
  const balanceDisplay = fmtCents(balanceCents);

  // 上次保存时间
  const lastSaved = storageGet(SAVE_TIME_KEY);
  const lastSavedDisplay = lastSaved
    ? new Date(lastSaved).toLocaleString()
    : "--";

  // 月份显示格式
  const formatMonth = (m: string) => {
    const [year, month] = m.split("-");
    return `${year}-${month}`;
  };

  return (
    <SecondaryView onClose={onClose} title={s.title} showTitle={false}>
      <div className="flex flex-col h-full overflow-x-hidden" style={{ backgroundColor: 'var(--app-bg)' }}>
        {/* 统计卡片 */}
        <div className="bg-[#059669] px-4 py-2 shadow-lg">
          {/* 月份筛选器 */}
          {availableMonths.length > 0 && (
            <div className="flex items-center justify-center gap-2 mb-1.5">
              <button
                onClick={goToPrevMonth}
                disabled={selectedMonth === "all" || currentMonthIndex >= availableMonths.length - 1}
                className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center disabled:opacity-30"
              >
                <ChevronLeft className="w-3 h-3 text-white" />
              </button>

              <button
                onClick={() => setSelectedMonth("all")}
                className={`px-3 py-0.5 rounded-full text-xs transition-all ${
                  selectedMonth === "all"
                    ? "bg-white text-emerald-600 font-medium"
                    : "bg-white/20 text-white"
                }`}
              >
                {ts("allMonths")}
              </button>

              {selectedMonth !== "all" && (
                <span className="text-white text-xs font-medium">
                  {formatMonth(selectedMonth)}
                </span>
              )}

              {availableMonths.slice(0, selectedMonth === "all" ? 3 : 0).map((m) => (
                <button
                  key={m}
                  onClick={() => setSelectedMonth(m)}
                  className={`px-2 py-0.5 rounded-full text-xs transition-all ${
                    selectedMonth === m
                      ? "bg-white text-emerald-600 font-medium"
                      : "bg-white/20 text-white"
                  }`}
                >
                  {formatMonth(m)}
                </button>
              ))}

              <button
                onClick={goToNextMonth}
                disabled={selectedMonth === "all" || currentMonthIndex <= 0}
                className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center disabled:opacity-30"
              >
                <ChevronRight className="w-3 h-3 text-white" />
              </button>
            </div>
          )}

          <div className="space-y-1.5">
            {/* 总余额 */}
            <div className="bg-white/20 rounded-lg px-3 py-1.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-white/20 flex items-center justify-center flex-shrink-0">
                  <Wallet className="w-3 h-3 text-white" />
                </div>
                <span className="text-white font-medium text-xs">{s.balance}</span>
              </div>
              <p className={`font-bold text-sm ${balanceCents >= 0 ? 'text-white' : 'text-red-200'}`}>
                {balanceDisplay}
              </p>
            </div>

            {/* 总收入 */}
            <div className="bg-white/20 rounded-lg px-3 py-1.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-white/20 flex items-center justify-center flex-shrink-0">
                  <TrendingUp className="w-3 h-3 text-green-200" />
                </div>
                <span className="text-white font-medium text-xs">{s.income}</span>
              </div>
              <p className="text-white font-bold text-sm">{incomeDisplay}</p>
            </div>

            {/* 总支出 */}
            <div className="bg-white/20 rounded-lg px-3 py-1.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-md bg-white/20 flex items-center justify-center flex-shrink-0">
                  <TrendingDown className="w-3 h-3 text-red-200" />
                </div>
                <span className="text-white font-medium text-xs">{s.expense}</span>
              </div>
              <p className="text-white font-bold text-sm">{expenseDisplay}</p>
            </div>

            {/* 数据状态栏 */}
            <div className="flex items-center justify-between px-1 pt-0.5">
              <div className="flex items-center gap-1 text-white/70 text-[10px]">
                <Shield className="w-2.5 h-2.5" />
                <span>{ts("recordCount", { count: transactions.length.toString() })}</span>
                <span className="mx-1">|</span>
                <span>{ts("lastBackup", { time: lastSavedDisplay })}</span>
              </div>
              <button
                onClick={() => setShowDataPanel(true)}
                className="flex items-center gap-1 text-white/80 text-[10px] bg-white/15 px-2 py-0.5 rounded-full active:scale-95 transition-transform"
              >
                <Database className="w-2.5 h-2.5" />
                {ts("dataManagement")}
              </button>
            </div>
          </div>
        </div>

        {/* 记账列表 */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-3 pb-24">
          {filteredTransactions.length === 0 ? (
            <div className="text-center py-16">
              <Wallet className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-400 text-sm">{s.noRecords}</p>
              <p className="text-gray-400 text-xs mt-1">{s.startRecording}</p>
            </div>
          ) : (
            filteredTransactions.map((transaction) => (
              <div
                key={transaction.id}
                className="bg-white rounded-2xl p-4 shadow-lg active:scale-95 transition-transform"
              >
                {/* 日期 */}
                <div className="flex items-center gap-1 text-gray-400 text-xs mb-3">
                  <Calendar className="w-3 h-3" />
                  {transaction.date}
                </div>

                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div
                          className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                            transaction.type === "income"
                              ? "bg-green-100"
                              : "bg-red-100"
                          }`}
                        >
                          {transaction.type === "income" ? (
                            <TrendingUp className="w-4 h-4 text-green-600" />
                          ) : (
                            <TrendingDown className="w-4 h-4 text-red-600" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-gray-800 text-sm">
                            {getCategoryLabel(transaction.categoryKey || transaction.category)}
                          </p>
                        </div>
                      </div>
                      <p
                        className={`font-bold text-lg ${
                          transaction.type === "income"
                            ? "text-green-600"
                            : "text-red-600"
                        }`}
                      >
                        {transaction.type === "income" ? "+" : "-"}
                        {transaction.amount.toFixed(2)}
                      </p>
                    </div>

                    {transaction.note && (
                      <p className="text-gray-500 text-xs mb-2 line-clamp-2">
                        {transaction.note}
                      </p>
                    )}

                    <div className="flex items-center gap-2 pt-2" style={{ borderTop: '1px solid rgba(0,0,0,0.04)' }}>
                      <button
                        onClick={() => handleEdit(transaction)}
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg text-xs active:scale-95 transition-transform"
                      >
                        <Edit className="w-3 h-3" />
                        {s.edit}
                      </button>
                      <button
                        onClick={() => handleDelete(transaction.id)}
                        className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs active:scale-95 transition-transform"
                      >
                        <Trash2 className="w-3 h-3" />
                        {s.delete}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 添加按钮 */}
        <div className="fixed bottom-20 ltr:right-4 rtl:left-4 z-20">
          <button
            onClick={() => {
              setShowAddForm(true);
              setEditingTransaction(null);
              setFormData({
                type: "expense",
                amount: "",
                category: "",
                categoryKey: "",
                note: "",
                date: new Date().toISOString().split("T")[0],
              });
            }}
            className="w-14 h-14 bg-emerald-600 text-white rounded-full shadow-2xl active:scale-90 transition-transform flex items-center justify-center"
          >
            <Plus className="w-6 h-6" />
          </button>
        </div>

        {/* 数据管理面板 */}
        {showDataPanel && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
            <div className="bg-white w-full rounded-t-3xl safe-bottom">
              <div className="sticky top-0 bg-white px-4 py-3 flex items-center justify-between" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                <h3 className="text-lg font-bold text-gray-800">{ts("dataManagement")}</h3>
                <button
                  onClick={() => setShowDataPanel(false)}
                  className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center active:scale-90 transition-transform"
                >
                  <X className="w-4 h-4 text-gray-600" />
                </button>
              </div>

              <div className="p-4 space-y-3">
                {/* 数据概览 */}
                <div className="bg-emerald-50 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield className="w-4 h-4 text-emerald-600" />
                    <span className="text-emerald-800 font-medium text-sm">
                      {ts("recordCount", { count: transactions.length.toString() })}
                    </span>
                  </div>
                  <p className="text-emerald-600 text-xs">
                    {ts("lastBackup", { time: lastSavedDisplay })}
                  </p>
                </div>

                {/* 导出按钮 */}
                <button
                  onClick={() => {
                    handleExport();
                    setShowDataPanel(false);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-blue-50 rounded-xl active:scale-95 transition-transform"
                >
                  <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
                    <Download className="w-5 h-5 text-blue-600" />
                  </div>
                  <div className="text-start">
                    <p className="text-blue-800 font-medium text-sm">{ts("exportData")}</p>
                    <p className="text-blue-500 text-xs">JSON</p>
                  </div>
                </button>

                {/* 导入按钮 */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-orange-50 rounded-xl active:scale-95 transition-transform"
                >
                  <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center">
                    <Upload className="w-5 h-5 text-orange-600" />
                  </div>
                  <div className="text-start">
                    <p className="text-orange-800 font-medium text-sm">{ts("importData")}</p>
                    <p className="text-orange-500 text-xs">JSON</p>
                  </div>
                </button>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json"
                  onChange={(e) => {
                    handleImport(e);
                    setShowDataPanel(false);
                  }}
                  className="hidden"
                />
              </div>
            </div>
          </div>
        )}

        {/* 添加/编辑表单弹窗 */}
        {showAddForm && (
          <div className="fixed inset-0 bg-black/50 z-50 flex items-end">
            <div className="bg-white w-full rounded-t-3xl max-h-[85vh] flex flex-col overflow-hidden">
              {/* 固定顶部：仅标题 */}
              <div className="flex-shrink-0 bg-white px-4 py-3 flex items-center justify-center rounded-t-3xl" style={{ boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                <h3 className="text-lg font-bold text-gray-800">
                  {editingTransaction ? s.editRecord : s.addRecord}
                </h3>
              </div>

              {/* 可滚动表单区域 */}
              <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-4">
                {/* 类型选择 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {s.type}
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() =>
                        setFormData({ ...formData, type: "expense", category: "", categoryKey: "" })
                      }
                      className={`py-3 px-4 rounded-xl font-medium text-sm transition-all ${
                        formData.type === "expense"
                          ? "bg-red-600 text-white shadow-lg"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      <TrendingDown className="w-4 h-4 inline me-1" />
                      {s.expense}
                    </button>
                    <button
                      onClick={() =>
                        setFormData({ ...formData, type: "income", category: "", categoryKey: "" })
                      }
                      className={`py-3 px-4 rounded-xl font-medium text-sm transition-all ${
                        formData.type === "income"
                          ? "bg-green-600 text-white shadow-lg"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      <TrendingUp className="w-4 h-4 inline me-1" />
                      {s.income}
                    </button>
                  </div>
                </div>

                {/* 金额输入 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {s.amount}
                  </label>
                  <div className="relative">
                    <DollarSign className="absolute inset-y-0 start-3 my-auto w-4 h-4 text-gray-400" />
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      value={formData.amount}
                      onChange={(e) =>
                        setFormData({ ...formData, amount: e.target.value })
                      }
                      placeholder="0.00"
                      className="w-full ps-10 pe-4 py-3 border border-gray-300 rounded-xl text-gray-800 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                    />
                  </div>
                </div>

                {/* 分类选择 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {s.category}
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(formData.type === "income"
                      ? incomeCategoryKeys
                      : expenseCategoryKeys
                    ).map((key) => (
                      <button
                        key={key}
                        onClick={() => setFormData({ ...formData, categoryKey: key, category: "" })}
                        className={`py-2 px-3 rounded-lg text-xs font-medium transition-all ${
                          formData.categoryKey === key
                            ? formData.type === "income"
                              ? "bg-green-600 text-white shadow-lg"
                              : "bg-red-600 text-white shadow-lg"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {getCategoryLabel(key)}
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={formData.categoryKey && !formData.category ? "" : formData.category}
                    onChange={(e) =>
                      setFormData({ ...formData, category: e.target.value, categoryKey: e.target.value })
                    }
                    placeholder={s.customCategory}
                    className="w-full mt-2 px-4 py-2 border border-gray-300 rounded-xl text-sm text-gray-800 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                  />
                </div>

                {/* 日期选择 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {s.date}
                  </label>
                  <div className="relative">
                    <Calendar className="absolute inset-y-0 start-3 my-auto w-4 h-4 text-gray-400" />
                    <input
                      type="date"
                      value={formData.date}
                      onChange={(e) =>
                        setFormData({ ...formData, date: e.target.value })
                      }
                      className="w-full ps-10 pe-4 py-3 border border-gray-300 rounded-xl text-gray-800 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none"
                    />
                  </div>
                </div>

                {/* 备注输入 */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {s.noteOptional}
                  </label>
                  <div className="relative">
                    <Tag className="absolute start-3 top-3 w-4 h-4 text-gray-400" />
                    <textarea
                      value={formData.note}
                      onChange={(e) =>
                        setFormData({ ...formData, note: e.target.value })
                      }
                      placeholder={s.notePlaceholder}
                      rows={3}
                      className="w-full ps-10 pe-4 py-3 border border-gray-300 rounded-xl text-gray-800 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none resize-none"
                    />
                  </div>
                </div>
              </div>

              {/* 固定底部：提交按钮 + 关闭按钮（与二级菜单 dock 统一） */}
              <div className="flex-shrink-0 bg-white safe-bottom">
                <div className="px-4 pt-3 pb-1">
                  <button
                    onClick={handleSubmit}
                    className="w-full py-4 bg-emerald-600 text-white font-bold rounded-xl active:scale-95 transition-transform shadow-lg"
                  >
                    {editingTransaction ? s.saveChanges : s.addRecord}
                  </button>
                </div>
                <div className="flex items-center justify-center px-1 pt-1.5 pb-2" style={{ boxShadow: '0 -1px 12px rgba(0,0,0,0.06)' }}>
                  <button
                    onClick={() => {
                      setShowAddForm(false);
                      setEditingTransaction(null);
                    }}
                    className="flex items-center justify-center pt-2.5 pb-1.5 active:scale-95 transition-transform touch-manipulation"
                    aria-label="关闭"
                  >
                    <X className="w-7 h-7 text-red-500" strokeWidth={1.8} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Toast 通知 */}
        {toast.visible && (
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[60] animate-[fadeInDown_0.2s_ease-out]">
            <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg ${
              toast.type === 'success' 
                ? 'bg-emerald-600 text-white' 
                : 'bg-red-600 text-white'
            }`}>
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              <span className="text-sm font-medium whitespace-nowrap">{toast.message}</span>
            </div>
          </div>
        )}
      </div>
    </SecondaryView>
  );
}

export default StatementPage;