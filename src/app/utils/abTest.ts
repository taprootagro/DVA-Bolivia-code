// ============================================================================
// A/B Testing Framework - 基于版本的灰度发布系统
// ============================================================================
// 支持多维度分组、版本控制、实验追踪、自动降级
//
// 核心功能：
//   1. 设备ID哈希分组（稳定分配）
//   2. 多实验并行支持
//   3. 版本维度分组（v3用户50%，v2用户100%等）
//   4. 特征开关（Feature Flags）
//   5. 实验数据采集
//   6. 自动异常检测与降级
//
// 使用场景：
//   - API版本灰度发布
//   - 新功能小流量测试
//   - UI/UX A/B测试
//   - 算法效果对比
// ============================================================================

import { getStableDeviceId } from './errorMonitor';
import { errorMonitor } from './errorMonitor';
import type { ApiVersion } from './apiVersion';
import { storageGetJSON, storageSetJSON } from './safeStorage';

// ============================================================================
// 类型定义
// ============================================================================

export type ABTestGroup = 'control' | 'treatment' | 'treatment-a' | 'treatment-b';

export interface ABTestExperiment {
  /** 实验ID */
  id: string;
  
  /** 实验名称 */
  name: string;
  
  /** 实验描述 */
  description?: string;
  
  /** 是否启用 */
  enabled: boolean;
  
  /** 分组配置 */
  groups: {
    /** 分组名称 */
    name: ABTestGroup;
    
    /** 流量占比（0-100）*/
    percentage: number;
    
    /** 分组配置（可包含API版本等）*/
    config?: Record<string, unknown>;
  }[];
  
  /** 目标API版本筛选（可选）*/
  targetVersions?: ApiVersion[];
  
  /** 实验开始时间 */
  startTime?: number;
  
  /** 实验结束时间 */
  endTime?: number;
  
  /** 最小样本量 */
  minSampleSize?: number;
  
  /** 异常降级配置 */
  fallback?: {
    /** 错误率阈值（%）*/
    errorRateThreshold: number;
    
    /** 检测窗口（ms）*/
    detectionWindow: number;
    
    /** 降级到哪个分组 */
    fallbackGroup: ABTestGroup;
  };
}

export interface ABTestAssignment {
  /** 设备ID */
  deviceId: string;
  
  /** 实验ID */
  experimentId: string;
  
  /** 分配的分组 */
  group: ABTestGroup;
  
  /** 分配时间 */
  assignedAt: number;
  
  /** 分组配置 */
  config?: Record<string, unknown>;
}

export interface ABTestMetrics {
  /** 实验ID */
  experimentId: string;
  
  /** 分组统计 */
  groupStats: Record<ABTestGroup, {
    /** 样本量 */
    sampleSize: number;
    
    /** 转化次数 */
    conversions: number;
    
    /** 转化率 */
    conversionRate: number;
    
    /** 错误次数 */
    errors: number;
    
    /** 错误率 */
    errorRate: number;
    
    /** 平均响应时间 */
    avgResponseTime: number;
  }>;
  
  /** 实验状态 */
  status: 'running' | 'completed' | 'stopped' | 'degraded';
  
  /** 更新时间 */
  lastUpdate: number;
}

// ============================================================================
// 本地存储键
// ============================================================================

const LS_KEY_EXPERIMENTS = '__taproot_ab_experiments__';
const LS_KEY_ASSIGNMENTS = '__taproot_ab_assignments__';
const LS_KEY_METRICS = '__taproot_ab_metrics__';

// ============================================================================
// 哈希函数（用于稳定分组）
// ============================================================================

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

function hashToPercentage(str: string): number {
  return simpleHash(str) % 100;
}

// ============================================================================
// A/B测试管理器
// ============================================================================

class ABTestManager {
  /**
   * 注册实验
   */
  registerExperiment(experiment: ABTestExperiment): void {
    const experiments = this.getExperiments();
    
    // 验证分组百分比总和为100
    const totalPercentage = experiment.groups.reduce((sum, g) => sum + g.percentage, 0);
    if (Math.abs(totalPercentage - 100) > 0.01) {
      throw new Error(`Experiment ${experiment.id}: group percentages must sum to 100 (got ${totalPercentage})`);
    }
    
    experiments[experiment.id] = experiment;
    this.saveExperiments(experiments);
    
    console.log(`[ABTest] Registered experiment: ${experiment.id} (${experiment.name})`);
  }

  /**
   * 获取用户分组
   */
  getAssignment(experimentId: string, apiVersion?: ApiVersion): ABTestAssignment | null {
    const experiment = this.getExperiment(experimentId);
    if (!experiment || !experiment.enabled) {
      return null;
    }
    
    // 检查版本筛选
    if (experiment.targetVersions && apiVersion) {
      if (!experiment.targetVersions.includes(apiVersion)) {
        return null;
      }
    }
    
    // 检查时间范围
    const now = Date.now();
    if (experiment.startTime && now < experiment.startTime) {
      return null;
    }
    if (experiment.endTime && now > experiment.endTime) {
      return null;
    }
    
    // 检查现有分配
    const existingAssignment = this.getExistingAssignment(experimentId);
    if (existingAssignment) {
      return existingAssignment;
    }
    
    // 新分配
    const deviceId = getStableDeviceId();
    const group = this.assignGroup(experimentId, deviceId, experiment);
    
    const assignment: ABTestAssignment = {
      deviceId,
      experimentId,
      group,
      assignedAt: Date.now(),
      config: experiment.groups.find(g => g.name === group)?.config,
    };
    
    this.saveAssignment(assignment);
    
    console.log(`[ABTest] Assigned ${deviceId} to ${experimentId}:${group}`);
    
    return assignment;
  }

  /**
   * 分配分组（基于设备ID哈希）
   */
  private assignGroup(
    experimentId: string,
    deviceId: string,
    experiment: ABTestExperiment
  ): ABTestGroup {
    const hashInput = `${experimentId}:${deviceId}`;
    const hashValue = hashToPercentage(hashInput);
    
    let cumulative = 0;
    for (const group of experiment.groups) {
      cumulative += group.percentage;
      if (hashValue < cumulative) {
        return group.name;
      }
    }
    
    // 默认返回对照组
    return 'control';
  }

  /**
   * 获取实验配置
   */
  getExperimentConfig(experimentId: string, apiVersion?: ApiVersion): Record<string, unknown> | null {
    const assignment = this.getAssignment(experimentId, apiVersion);
    return assignment?.config || null;
  }

  /**
   * 检查是否在实验组
   */
  isInGroup(experimentId: string, group: ABTestGroup, apiVersion?: ApiVersion): boolean {
    const assignment = this.getAssignment(experimentId, apiVersion);
    return assignment?.group === group;
  }

  /**
   * 记录转化事件
   */
  trackConversion(experimentId: string, responseTime?: number): void {
    const assignment = this.getExistingAssignment(experimentId);
    if (!assignment) return;
    
    const metrics = this.getOrCreateMetrics(experimentId);
    const groupStats = metrics.groupStats[assignment.group];
    
    if (groupStats) {
      groupStats.conversions++;
      groupStats.conversionRate = groupStats.conversions / groupStats.sampleSize;
      
      if (responseTime) {
        const totalTime = groupStats.avgResponseTime * (groupStats.sampleSize - 1);
        groupStats.avgResponseTime = (totalTime + responseTime) / groupStats.sampleSize;
      }
      
      metrics.lastUpdate = Date.now();
      this.saveMetrics(experimentId, metrics);
    }
  }

  /**
   * 记录错误事件
   */
  trackError(experimentId: string): void {
    const assignment = this.getExistingAssignment(experimentId);
    if (!assignment) return;
    
    const metrics = this.getOrCreateMetrics(experimentId);
    const groupStats = metrics.groupStats[assignment.group];
    
    if (groupStats) {
      groupStats.errors++;
      groupStats.errorRate = groupStats.errors / groupStats.sampleSize;
      
      metrics.lastUpdate = Date.now();
      this.saveMetrics(experimentId, metrics);
      
      // 检查是否需要降级
      this.checkAndDegrade(experimentId, metrics);
    }
  }

  /**
   * 检查并执行降级
   */
  private checkAndDegrade(experimentId: string, metrics: ABTestMetrics): void {
    const experiment = this.getExperiment(experimentId);
    if (!experiment?.fallback) return;
    
    const { errorRateThreshold, fallbackGroup } = experiment.fallback;
    
    // 检查所有实验组错误率
    for (const [groupName, stats] of Object.entries(metrics.groupStats)) {
      if (groupName === 'control') continue; // 不检查对照组
      
      if (stats.errorRate * 100 > errorRateThreshold) {
        console.error(
          `[ABTest] High error rate detected in ${experimentId}:${groupName} (${stats.errorRate.toFixed(2)}%), degrading...`
        );
        
        metrics.status = 'degraded';
        this.saveMetrics(experimentId, metrics);
        
        // 重新分配所有该分组用户到降级组
        this.degradeGroup(experimentId, groupName as ABTestGroup, fallbackGroup);
        
        break;
      }
    }
  }

  /**
   * 降级指定分组
   */
  private degradeGroup(
    experimentId: string,
    fromGroup: ABTestGroup,
    toGroup: ABTestGroup
  ): void {
    const assignments = this.getAllAssignments();
    
    for (const assignment of Object.values(assignments)) {
      if (assignment.experimentId === experimentId && assignment.group === fromGroup) {
        assignment.group = toGroup;
        assignment.config = this.getExperiment(experimentId)?.groups.find(g => g.name === toGroup)?.config;
      }
    }
    
    this.saveAllAssignments(assignments);
    
    console.log(`[ABTest] Degraded ${experimentId}:${fromGroup} → ${toGroup}`);
  }

  /**
   * 获取实验指标
   */
  getMetrics(experimentId: string): ABTestMetrics | null {
    try {
      const allMetrics = storageGetJSON<Record<string, ABTestMetrics>>(LS_KEY_METRICS, {}) || {};
      return allMetrics[experimentId] || null;
    } catch {
      return null;
    }
  }

  /**
   * 获取所有实验
   */
  getExperiments(): Record<string, ABTestExperiment> {
    return storageGetJSON<Record<string, ABTestExperiment>>(LS_KEY_EXPERIMENTS, {}) || {};
  }

  /**
   * 获取单个实验
   */
  getExperiment(experimentId: string): ABTestExperiment | null {
    const experiments = this.getExperiments();
    return experiments[experimentId] || null;
  }

  /**
   * 停止实验
   */
  stopExperiment(experimentId: string): void {
    const experiments = this.getExperiments();
    if (experiments[experimentId]) {
      experiments[experimentId].enabled = false;
      this.saveExperiments(experiments);
      
      const metrics = this.getMetrics(experimentId);
      if (metrics) {
        metrics.status = 'stopped';
        this.saveMetrics(experimentId, metrics);
      }
      
      console.log(`[ABTest] Stopped experiment: ${experimentId}`);
    }
  }

  /**
   * 清除实验数据
   */
  clearExperiment(experimentId: string): void {
    // 清除实验配置
    const experiments = this.getExperiments();
    delete experiments[experimentId];
    this.saveExperiments(experiments);
    
    // 清除分配记录
    const assignments = this.getAllAssignments();
    for (const key of Object.keys(assignments)) {
      if (assignments[key].experimentId === experimentId) {
        delete assignments[key];
      }
    }
    this.saveAllAssignments(assignments);
    
    // 清除指标
    const allMetrics = storageGetJSON<Record<string, ABTestMetrics>>(LS_KEY_METRICS, {}) || {};
    delete allMetrics[experimentId];
    storageSetJSON(LS_KEY_METRICS, allMetrics);
    
    console.log(`[ABTest] Cleared experiment: ${experimentId}`);
  }

  // ---- Internal ----

  private getExistingAssignment(experimentId: string): ABTestAssignment | null {
    const assignments = this.getAllAssignments();
    const deviceId = getStableDeviceId();
    const key = `${deviceId}:${experimentId}`;
    return assignments[key] || null;
  }

  private getAllAssignments(): Record<string, ABTestAssignment> {
    return storageGetJSON<Record<string, ABTestAssignment>>(LS_KEY_ASSIGNMENTS, {}) || {};
  }

  private saveAssignment(assignment: ABTestAssignment): void {
    const assignments = this.getAllAssignments();
    const key = `${assignment.deviceId}:${assignment.experimentId}`;
    assignments[key] = assignment;
    this.saveAllAssignments(assignments);
    
    // 更新样本量统计
    const metrics = this.getOrCreateMetrics(assignment.experimentId);
    const groupStats = metrics.groupStats[assignment.group];
    if (groupStats) {
      groupStats.sampleSize++;
      this.saveMetrics(assignment.experimentId, metrics);
    }
  }

  private saveAllAssignments(assignments: Record<string, ABTestAssignment>): void {
    storageSetJSON(LS_KEY_ASSIGNMENTS, assignments);
  }

  private saveExperiments(experiments: Record<string, ABTestExperiment>): void {
    storageSetJSON(LS_KEY_EXPERIMENTS, experiments);
  }

  private getOrCreateMetrics(experimentId: string): ABTestMetrics {
    let metrics = this.getMetrics(experimentId);
    
    if (!metrics) {
      const experiment = this.getExperiment(experimentId);
      if (!experiment) {
        throw new Error(`Experiment ${experimentId} not found`);
      }
      
      metrics = {
        experimentId,
        groupStats: {},
        status: 'running',
        lastUpdate: Date.now(),
      };
      
      // 初始化所有分组统计
      for (const group of experiment.groups) {
        metrics.groupStats[group.name] = {
          sampleSize: 0,
          conversions: 0,
          conversionRate: 0,
          errors: 0,
          errorRate: 0,
          avgResponseTime: 0,
        };
      }
    }
    
    return metrics;
  }

  private saveMetrics(experimentId: string, metrics: ABTestMetrics): void {
    try {
      const allMetrics = storageGetJSON<Record<string, ABTestMetrics>>(LS_KEY_METRICS, {}) || {};
      allMetrics[experimentId] = metrics;
      storageSetJSON(LS_KEY_METRICS, allMetrics);
    } catch {
      // Ignore storage errors
    }
  }
}

// ============================================================================
// 单例导出
// ============================================================================

export const abTestManager = new ABTestManager();

// ============================================================================
// 预定义实验示例
// ============================================================================

/**
 * API版本灰度发布实验
 */
export function createVersionRolloutExperiment(
  version: ApiVersion,
  percentage: number
): ABTestExperiment {
  return {
    id: `api-version-${version}-rollout`,
    name: `API ${version} Rollout`,
    description: `Gradual rollout of API ${version} to ${percentage}% of users`,
    enabled: true,
    groups: [
      {
        name: 'control',
        percentage: 100 - percentage,
        config: { useNewVersion: false },
      },
      {
        name: 'treatment',
        percentage,
        config: { useNewVersion: true, apiVersion: version },
      },
    ],
    fallback: {
      errorRateThreshold: 5, // 5% error rate triggers fallback
      detectionWindow: 60000, // 1 minute
      fallbackGroup: 'control',
    },
  };
}