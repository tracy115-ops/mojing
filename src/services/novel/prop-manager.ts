// ============================================================================
// Prop Lifecycle Management System
// Inspired by PlotPilot's Prop aggregate root with lifecycle state machine
//
// Features:
// - Prop entity with state machine (DORMANT → INTRODUCED → ACTIVE → DAMAGED → RESOLVED)
// - Event-sourced lifecycle transitions with validation
// - LLM-powered extraction of prop events from chapter content
// - Context injection into T1 context budget slot
// ============================================================================

import type { LLMGenerateRequest } from '@/types/providers';
import { providerRouter } from '@/services/providers';
import { NarrativeRepository } from './narrative-repository';

// --- Types ---

export type PropCategory = 'weapon' | 'artifact' | 'tool' | 'consumable' | 'token' | 'clothing' | 'mount' | 'other';

export type LifecycleState = 'dormant' | 'introduced' | 'active' | 'damaged' | 'resolved';

export type PropEventType =
  | 'introduced'   // 首次登场
  | 'used'         // 被使用
  | 'transferred'  // 持有者变更
  | 'damaged'      // 损毁
  | 'repaired'     // 修复
  | 'upgraded'     // 升级/进化
  | 'consumed'     // 消耗（一次性道具）
  | 'resolved';    // 结局/消失

export interface PropEvent {
  id: string;
  propId: string;
  chapterNumber: number;
  eventType: PropEventType;
  description: string;
  actorCharacterId?: string;
  fromHolderId?: string;
  toHolderId?: string;
  timestamp: string;
}

export interface Prop {
  id: string;
  novelId: string;
  name: string;
  description: string;
  aliases: string[];
  category: PropCategory;
  lifecycleState: LifecycleState;
  introducedChapter?: number;
  resolvedChapter?: number;
  holderCharacterId?: string;
  attributes: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

// --- Lifecycle State Machine ---

const VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  dormant: ['introduced'],
  introduced: ['active', 'resolved'],
  active: ['damaged', 'resolved', 'active'],  // active → active for upgrade events
  damaged: ['active', 'resolved'],
  resolved: [],
};

function validateTransition(current: LifecycleState, target: LifecycleState): void {
  const allowed = VALID_TRANSITIONS[current] ?? [];
  if (!allowed.includes(target)) {
    throw new Error(
      `非法道具状态转换: ${current} → ${target}，允许: [${allowed.join(', ')}]`,
    );
  }
}

function eventTypeToState(eventType: PropEventType): LifecycleState | null {
  const mapping: Record<PropEventType, LifecycleState> = {
    introduced: 'introduced',
    used: 'active',
    transferred: 'active',
    damaged: 'damaged',
    repaired: 'active',
    upgraded: 'active',
    consumed: 'resolved',
    resolved: 'resolved',
  };
  return mapping[eventType] ?? null;
}

// --- Prop Manager ---

export class PropManager {
  private repo: NarrativeRepository;

  constructor(novelId: string) {
    this.repo = new NarrativeRepository(novelId);
  }

  // --- CRUD ---

  createProp(params: Omit<Prop, 'id' | 'createdAt' | 'updatedAt' | 'lifecycleState' | 'attributes'> & { attributes?: Record<string, string> }): Prop {
    const prop: Prop = {
      ...params,
      id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      lifecycleState: 'dormant',
      attributes: params.attributes ?? {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const props = this.loadAll();
    props.push(prop);
    this.saveAll(props);
    return prop;
  }

  updateProp(propId: string, updates: Partial<Omit<Prop, 'id' | 'novelId'>>): Prop | undefined {
    const props = this.loadAll();
    const idx = props.findIndex((p) => p.id === propId);
    if (idx < 0) return undefined;
    props[idx] = { ...props[idx], ...updates, updatedAt: new Date().toISOString() };
    this.saveAll(props);
    return props[idx];
  }

  deleteProp(propId: string): void {
    const props = this.loadAll().filter((p) => p.id !== propId);
    this.saveAll(props);
  }

  getProp(propId: string): Prop | undefined {
    return this.loadAll().find((p) => p.id === propId);
  }

  loadAll(): Prop[] {
    try {
      const raw = localStorage.getItem(this.storageKey());
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  // --- Lifecycle ---

  /**
   * Apply an event to a prop, validating the state transition.
   */
  applyEvent(event: PropEvent): Prop {
    const props = this.loadAll();
    const prop = props.find((p) => p.id === event.propId);
    if (!prop) throw new Error(`Prop not found: ${event.propId}`);

    const targetState = eventTypeToState(event.eventType);
    if (targetState) {
      validateTransition(prop.lifecycleState, targetState);
      prop.lifecycleState = targetState;
    }

    if (event.eventType === 'introduced' && prop.introducedChapter === undefined) {
      prop.introducedChapter = event.chapterNumber;
    }

    if (event.eventType === 'resolved' || event.eventType === 'consumed') {
      prop.resolvedChapter = event.chapterNumber;
    }

    if (event.eventType === 'transferred' && event.toHolderId) {
      prop.holderCharacterId = event.toHolderId;
    }

    prop.updatedAt = new Date().toISOString();
    this.saveAll(props);

    // Also persist the event
    this.saveEvent(event);

    return prop;
  }

  /**
   * Check if a prop is active (visible) in a given chapter.
   */
  isActiveInChapter(prop: Prop, chapter: number): boolean {
    const intro = prop.introducedChapter ?? Infinity;
    const resolved = prop.resolvedChapter ?? Infinity;
    return intro <= chapter && chapter < resolved;
  }

  /**
   * Get all props active in a given chapter.
   */
  getActiveProps(chapter: number): Prop[] {
    return this.loadAll().filter((p) => this.isActiveInChapter(p, chapter));
  }

  // --- LLM Extraction ---

  /**
   * Extract prop events from chapter content using LLM.
   * Only extracts high-value events (transfers, damage, resolution).
   */
  async extractEventsFromChapter(
    chapterNumber: number,
    chapterContent: string,
  ): Promise<PropEvent[]> {
    const activeProps = this.loadAll().filter((p) =>
      p.lifecycleState !== 'dormant' && p.lifecycleState !== 'resolved',
    );

    if (activeProps.length === 0 || chapterContent.trim().length < 300) {
      return [];
    }

    const propsSummary = activeProps.slice(0, 20).map(
      (p) => `- ${p.name}（id=${p.id}，持有者=${p.holderCharacterId ?? '无'}，状态=${p.lifecycleState}）`,
    ).join('\n');

    const request: LLMGenerateRequest = {
      taskType: 'extraction',
      systemPrompt: `你是一个叙事道具状态追踪引擎。从章节正文中提取道具相关的状态变化事件。

当前活跃道具：
${propsSummary}

只提取以下高价值事件：
1. TRANSFERRED: 道具持有者变更（谁交给谁）
2. DAMAGED: 道具损毁/受损
3. REPAIRED: 道具修复
4. RESOLVED: 道具永久消失/销毁/结局
5. INTRODUCED: 新道具首次出现（用名字和描述）
6. UPGRADED: 道具升级/进化

输出严格JSON数组：
[
  {
    "propId": "道具ID（已有道具用id，新道具用null）",
    "propName": "道具名称",
    "eventType": "introduced|transferred|damaged|repaired|resolved|upgraded",
    "description": "事件描述",
    "actorCharacterId": "操作者角色名",
    "fromHolderId": "原持有者角色名（transferred时）",
    "toHolderId": "新持有者角色名（transferred时）",
    "isNewProp": false
  }
]

如果没有道具事件，返回空数组 []。`,
      userPrompt: `章节号: ${chapterNumber}\n\n${chapterContent.slice(0, 3000)}`,
      responseFormat: 'json',
      temperature: 0.1,
      maxTokens: 1024,
    };

    try {
      const response = await providerRouter.generate(request);
      const items = JSON.parse(response.content);
      if (!Array.isArray(items)) return [];

      const events: PropEvent[] = [];

      for (const item of items) {
        // If new prop, create it first
        if (item.isNewProp || !item.propId) {
          const newProp = this.createProp({
            novelId: this.repo['novelId'],
            name: item.propName ?? '未知道具',
            description: item.description ?? '',
            aliases: [],
            category: 'other',
            holderCharacterId: item.toHolderId,
          });
          item.propId = newProp.id;
        }

        events.push({
          id: `pe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          propId: item.propId,
          chapterNumber,
          eventType: item.eventType,
          description: item.description ?? '',
          actorCharacterId: item.actorCharacterId,
          fromHolderId: item.fromHolderId,
          toHolderId: item.toHolderId,
          timestamp: new Date().toISOString(),
        });
      }

      // Apply all events
      for (const event of events) {
        try {
          this.applyEvent(event);
        } catch (err) {
          console.warn(`PropManager: failed to apply event ${event.eventType}`, err);
        }
      }

      return events;
    } catch (err) {
      console.warn('PropManager: LLM extraction failed', err);
      return [];
    }
  }

  // --- Context Injection ---

  /**
   * Build context text for injection into T1 context budget slot.
   * Returns fact lock, suggestions, and warnings.
   */
  buildContextForChapter(chapterNumber: number, involvedCharacters?: string[]): {
    factLock: string;
    suggestions: string;
    warnings: string;
  } {
    const allProps = this.loadAll();
    const active = allProps.filter((p) => this.isActiveInChapter(p, chapterNumber));

    // Filter by involved characters if provided
    const relevant = involvedCharacters?.length
      ? active.filter((p) =>
          !p.holderCharacterId ||
          involvedCharacters.includes(p.holderCharacterId),
        )
      : active;

    // Fact lock
    let factLock = '';
    if (relevant.length > 0) {
      const lines = ['【道具状态锁 — 不可违反】'];
      for (const p of relevant) {
        const holder = p.holderCharacterId ? `持有者: ${p.holderCharacterId}` : '无持有者';
        lines.push(`- ${p.name}（${holder}）: ${this.displayState(p)}`);
        if (p.lifecycleState === 'damaged') {
          lines.push(`  ⚠ 已损毁，需描述损毁后的表现`);
        }
      }
      factLock = lines.join('\n');
    }

    // Suggestions — dormant/unused props that could be brought back
    const dormantLong = allProps.filter(
      (p) =>
        (p.lifecycleState === 'dormant' || p.lifecycleState === 'introduced') &&
        (!p.introducedChapter || chapterNumber - p.introducedChapter > 3),
    ).slice(0, 5);

    let suggestions = '';
    if (dormantLong.length > 0) {
      const lines = ['【道具建议引入 — 可忽略】'];
      for (const p of dormantLong) {
        const holder = p.holderCharacterId ? `由${p.holderCharacterId}持有` : '无持有者';
        lines.push(`- ${p.name}（${this.displayState(p)}，${holder}）: ${p.description.slice(0, 60)}`);
      }
      suggestions = lines.join('\n');
    }

    // Warnings
    const damagedProps = relevant.filter((p) => p.lifecycleState === 'damaged');
    let warnings = '';
    if (damagedProps.length > 0) {
      const lines = ['【道具一致性警告】'];
      for (const p of damagedProps) {
        lines.push(`⚠ ${p.name} 已损毁，请勿描述为完整状态`);
      }
      warnings = lines.join('\n');
    }

    return { factLock, suggestions, warnings };
  }

  displayState(prop: Prop): string {
    const labels: Record<LifecycleState, string> = {
      dormant: '未登场',
      introduced: '已登场',
      active: '使用中',
      damaged: '损毁',
      resolved: '已结局',
    };
    return labels[prop.lifecycleState] ?? prop.lifecycleState;
  }

  // --- Persistence ---

  private storageKey(): string {
    return `mojing-narrative:${this.repo['novelId']}:props`;
  }

  private eventsKey(): string {
    return `mojing-narrative:${this.repo['novelId']}:prop-events`;
  }

  private saveAll(props: Prop[]): void {
    localStorage.setItem(this.storageKey(), JSON.stringify(props));
  }

  private saveEvent(event: PropEvent): void {
    try {
      const raw = localStorage.getItem(this.eventsKey());
      const events: PropEvent[] = raw ? JSON.parse(raw) : [];
      events.push(event);
      localStorage.setItem(this.eventsKey(), JSON.stringify(events));
    } catch { /* swallow */ }
  }

  loadEvents(): PropEvent[] {
    try {
      const raw = localStorage.getItem(this.eventsKey());
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
}
