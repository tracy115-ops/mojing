# 三层架构开发规范

## 架构分层

本项目严格遵循三层架构模式：

```
┌─────────────────────────────────────────┐
│          Command Layer (命令层)          │
│  职责：参数校验、权限检查、转发请求         │
└──────────────┬──────────────────────────┘
               │ 调用
               ▼
┌─────────────────────────────────────────┐
│          Service Layer (服务层)          │
│  职责：执行业务逻辑、事务管理、编排流程     │
└──────────────┬──────────────────────────┘
               │ 调用
               ▼
┌─────────────────────────────────────────┐
│         Database Layer (数据层)          │
│  职责：SQL 执行、数据访问、对象映射         │
└─────────────────────────────────────────┘
```

## 层级职责

### Command 层（命令层）

**职责：**
- ✅ 参数非空校验
- ✅ 参数格式校验
- ✅ 权限检查
- ✅ 调用 Service 层方法
- ❌ **禁止**编写业务逻辑
- ❌ **禁止**直接操作数据库

**示例：**
```rust
// commands/session.rs
#[tauri::command]
pub async fn create_session(title: Option<String>) -> Result<Session, String> {
    // ✅ 参数校验
    let title = title.unwrap_or_else(|| "未命名会话".to_string());
    if title.trim().is_empty() {
        return Err("会话标题不能为空".to_string());
    }

    // ✅ 转发到 Service 层
    session_service::create_session(title).await
}
```

### Service 层（服务层）

**职责：**
- ✅ 执行业务逻辑
- ✅ 事务管理
- ✅ 编排多个 Database 操作
- ✅ 调用其他 Service
- ❌ **禁止**直接编写 SQL
- ❌ **禁止**越过 Database 层访问数据

**示例：**
```rust
// services/session_service.rs
pub async fn create_session(title: String) -> Result<Session, Error> {
    // ✅ 业务逻辑
    let now = Utc::now();
    let session = Session {
        id: Uuid::new_v4().to_string(),
        title: title.clone(),
        created_at: now,
        updated_at: now,
        message_count: 0,
    };

    // ✅ 调用 Database 层
    database::session::insert(&session).await?;

    // ✅ 可以编排多个操作
    database::session_index::add_to_index(&session).await?;

    Ok(session)
}
```

### Database 层（数据层）

**职责：**
- ✅ 执行 SQL (INSERT/UPDATE/DELETE/SELECT)
- ✅ 数据对象映射
- ✅ 数据库连接管理
- ❌ **禁止**编写业务逻辑
- ❌ **禁止**调用 Service 层

**示例：**
```rust
// database/session.rs
pub async fn insert(session: &Session) -> Result<(), Error> {
    let conn = db::get_connection().await?;

    // ✅ 只负责 SQL 执行
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, updated_at, message_count)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        [&session.id, &session.title, &session.created_at, &session.updated_at, &session.message_count],
    ).await?;

    Ok(())
}
```

## 跨层调用规则

### ✅ 允许的调用

```
Command → Service → Database
```

### ❌ 禁止的调用

```
Command → Database      (跨层调用)
Service → Command       (反向调用)
Database → Service      (反向调用)
```

## 前端对应架构

前端也应遵循类似的分层原则：

```
Component (视图层)
    ↓
Store/Hook (状态管理层)
    ↓
API Service (API 调用层)
```

### 前端分层示例

```typescript
// ✅ 正确：Component → Store → API
// components/SessionTree.tsx
const SessionTree: React.FC = () => {
  const { fetchSessions } = useSessionStore();  // 调用 Store

  useEffect(() => {
    fetchSessions();  // Store 负责调用 API
  }, []);

  return <div>{sessions.map(...)}</div>;
};

// stores/sessionStore.ts
export const useSessionStore = create((set, get) => ({
  sessions: [],
  fetchSessions: async () => {
    // ✅ Store 负责调用 API
    const sessions = await invoke<Session[]>('list_sessions');
    set({ sessions });
  },
}));
```

## 常见错误示例

### ❌ 错误 1：Command 层包含业务逻辑

```rust
// 不要这样做
#[tauri::command]
pub async fn create_session(title: String) -> Result<Session, String> {
    // ❌ 业务逻辑应该在 Service 层
    let is_duplicate = database::session::check_duplicate(&title).await?;
    if is_duplicate {
        return Err("会话已存在".to_string());
    }

    let session = Session { ... };
    database::session::insert(&session).await?;
    Ok(session)
}
```

### ❌ 错误 2：Service 层直接写 SQL

```rust
// 不要这样做
pub async fn create_session(title: String) -> Result<Session, Error> {
    // ❌ SQL 应该在 Database 层
    let conn = db::get_connection().await?;
    conn.execute("INSERT INTO sessions ...", []).await?;
    Ok(session)
}
```

### ❌ 错误 3：跨层调用

```rust
// 不要这样做
#[tauri::command]
pub async fn delete_session(id: String) -> Result<(), String> {
    // ❌ Command 不应该直接调用 Database
    database::session::delete(&id).await?;
    Ok(())
}
```

## 检查清单

在提交代码前，请确认：

- [ ] Command 层只做参数校验和转发
- [ ] Service 层包含业务逻辑，调用 Database 层
- [ ] Database 层只执行 SQL 和数据映射
- [ ] 没有跨层调用（Command → Database）
- [ ] 前端遵循 Component → Store → API 的调用链

## 文件组织

```
src/
├── commands/           # Tauri 命令（Command 层）
│   ├── mod.rs
│   ├── session.rs
│   ├── message.rs
│   └── token.rs
├── services/           # 业务逻辑（Service 层）
│   ├── mod.rs
│   ├── session_service.rs
│   ├── message_service.rs
│   └── token_service.rs
├── database/           # 数据访问（Database 层）
│   ├── mod.rs
│   ├── session.rs
│   ├── message.rs
│   └── token.rs
└── lib.rs             # 注册 Tauri 命令
```

## 注意事项

1. **单向依赖**：上层可以调用下层，下层不能调用上层
2. **职责单一**：每层只做自己该做的事
3. **易于测试**：分层后可以单独测试每一层
4. **便于维护**：修改业务逻辑只需要改 Service 层
