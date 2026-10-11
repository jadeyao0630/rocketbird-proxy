export interface MonthlyReportPayload {
  storeId: string;
  storeName: string;
  month: string;
  revenue: {
    cardSales: { total: number; list: any[] };
    courseSales: { total: number; list: any[] };
    renewals: { total: number; list: any[] };
    courseConsumed: { total: number; count: number; list: any[] };
  };
  fixedCost: {
    propertyFee: number;
    electricityFee: number;
    rent: number;
    waterFee: number;
    networkFee: number;
    otherFee: number;
    total: number;
  };
  payroll: {
    headcount: number;
    baseSalary: number;
    salesCommission: number;
    classCommission: number;
    rewardsTotal: number;
    total: number;
  };
  dingtalkExpenses: {
    total: number;
    items: any[];
  };
  summary: {
    totalIncome: number;
    totalExpense: number;
    profit: number;
    isProfit: boolean;
  };
}

/* ============================================================
 * 智能提取"金额"
 * ============================================================ */
function pickAmount(it: any): number {
  if (!it || typeof it !== 'object') return 0;

  const preferred = [
    'amount', 'total_amount', 'totalAmount',
    'real_amount', 'realAmount', 'pay_amount', 'payAmount',
    'money', 'price', 'sale_amount', 'saleAmount',
    'received_amount', 'receivedAmount', 'income', 'income_amount',
    'card_amount', 'cardAmount', 'course_amount', 'courseAmount',
  ];
  for (const k of preferred) {
    const v = it[k];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(String(v).replace(/[^\d.-]/g, ''));
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }

  for (const k of Object.keys(it)) {
    const lk = String(k).toLowerCase();
    if (lk.includes('amount') || lk.includes('money') || k.includes('金额')) {
      const v = it[k];
      const n = Number(String(v).replace(/[^\d.-]/g, ''));
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }
  return 0;
}

/* ============================================================
 * 智能判断"售卡 / 售课"
 *    - card_type_id: 1/2 = 售卡，3 = 场地合同，4/5 = 售课
 * ============================================================ */
function classifyOrder(it: any): 'card' | 'course' {
  if (!it || typeof it !== 'object') return 'card';

  const typeVal = String(
    it.card_type_id ??
      it.card_type ??
      it.cardType ??
      it.order_type ??
      it.orderType ??
      it.type ??
      it.sale_type ??
      it.saleType ??
      it.category ??
      ''
  ).toLowerCase();

  const nameVal = String(
    it.card_name ?? it.cardName ?? it.course_name ?? it.courseName ??
      it.product_name ?? it.productName ?? it.title ?? it.name ?? ''
  ).toLowerCase();

  /* 4 / 5 → 私教、泳教 = 售课 */
  if (typeVal === '4' || typeVal === '5') return 'course';
  if (
    typeVal.includes('course') ||
    nameVal.includes('课') ||
    nameVal.includes('私教') ||
    nameVal.includes('泳教')
  ) {
    return 'course';
  }

  /* 1 / 2 / 3 → 会籍卡、场地合同 = 售卡 */
  if (typeVal === '1' || typeVal === '2' || typeVal === '3') return 'card';
  if (typeVal.includes('card')) return 'card';

  /* 兜底：售卡 */
  return 'card';
}

/* ============================================================
 * ⭐ 拼 AI payload
 *    - 只传汇总，list 永远为空数组（避免 413）
 * ============================================================ */
export function buildPayload(params: {
  storeId: string;
  storeName: string;
  month: string;
  orderList: any[];
  payrollResults: any[];
  fixedCostDetail: {
    propertyFee: number;
    electricityFee: number;
    rent: number;
    waterFee: number;
    networkFee: number;
    otherFee: number;
  };
}): MonthlyReportPayload {
  const {
    storeId,
    storeName,
    month,
    orderList,
    payrollResults,
    fixedCostDetail,
  } = params;
  console.log('=== 我改的 buildPayload 被调用了 v2 ===', new Date().toISOString());
  console.log('[buildPayload] 订单总数 =', orderList?.length || 0);

  const cardOrders: any[] = [];
  const courseOrders: any[] = [];
  (orderList || []).forEach((o) => {
    if (classifyOrder(o) === 'course') courseOrders.push(o);
    else cardOrders.push(o);
  });

  const sum = (list: any[]) => list.reduce((s, it) => s + pickAmount(it), 0);

  console.log(
    '[buildPayload] 售卡 %d 条（¥%s），售课 %d 条（¥%s）',
    cardOrders.length,
    sum(cardOrders),
    courseOrders.length,
    sum(courseOrders)
  );

  const payrollSummary = (payrollResults || []).reduce(
    (acc: any, r: any) => ({
      headcount: acc.headcount + 1,
      baseSalary: acc.baseSalary + Number(r.baseSalary || 0),
      salesCommission:
        acc.salesCommission + Number(r.salesCommission || 0),
      classCommission:
        acc.classCommission + Number(r.classCommission || 0),
      rewardsTotal: acc.rewardsTotal + Number(r.rewardsTotal || 0),
      total: acc.total + Number(r.total || 0),
    }),
    {
      headcount: 0,
      baseSalary: 0,
      salesCommission: 0,
      classCommission: 0,
      rewardsTotal: 0,
      total: 0,
    }
  );

  const fixedCost = {
    ...fixedCostDetail,
    total:
      fixedCostDetail.propertyFee +
      fixedCostDetail.electricityFee +
      fixedCostDetail.rent +
      fixedCostDetail.waterFee +
      fixedCostDetail.networkFee +
      fixedCostDetail.otherFee,
  };

  const dingtalkExpenses = { total: 0, items: [] };

  const totalIncome = sum(cardOrders) + sum(courseOrders);
  const totalExpense = fixedCost.total + payrollSummary.total;
  const profit = totalIncome - totalExpense;

  console.log(
    '[buildPayload] 收入合计 = ¥%s，支出合计 = ¥%s，利润 = ¥%s',
    totalIncome,
    totalExpense,
    profit
  );

  return {
    storeId,
    storeName,
    month,
    revenue: {
      /* ⭐ 只传汇总，list 永远为空 */
      cardSales: { total: sum(cardOrders), list: [] },
      courseSales: { total: sum(courseOrders), list: [] },
      renewals: { total: 0, list: [] },
      courseConsumed: { total: 0, count: 0, list: [] },
    },
    fixedCost,
    payroll: payrollSummary,
    dingtalkExpenses,
    summary: {
      totalIncome,
      totalExpense,
      profit,
      isProfit: profit >= 0,
    },
  };
}

/* ============================================================
 * 调后端 → 豆包生成报告
 * ============================================================ */
export async function generateAiReport(
  payload: MonthlyReportPayload
): Promise<string> {
  const res = await fetch(`/api/ai/monthly-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`后端返回 ${res.status}：${text.slice(0, 300)}`);
  }

  const json = await res.json();
  if (json.errorcode !== 0) {
    throw new Error(json.errormsg || 'AI 报告生成失败');
  }
  return json.data?.analysis || '';
}