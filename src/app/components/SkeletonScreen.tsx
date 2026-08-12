// 通用骨架屏组件 - 快速显示框架
export function SkeletonScreen() {
  return (
    <div className="h-screen flex flex-col bg-white animate-pulse">
      {/* 顶部状态栏 */}
      <div className="bg-emerald-600 h-10 flex-shrink-0"></div>
      
      {/* 内容区域 */}
      <div className="flex-1 p-4 space-y-4">
        <div className="h-8 bg-gray-200 rounded"></div>
        <div className="h-32 bg-gray-200 rounded"></div>
        <div className="h-24 bg-gray-200 rounded"></div>
        <div className="h-24 bg-gray-200 rounded"></div>
      </div>
      
      {/* 底部导航栏 */}
      <div className="flex-shrink-0 bg-white safe-bottom" style={{ boxShadow: '0 -1px 12px rgba(0,0,0,0.06)' }}>
        <div className="flex justify-around items-center px-4" style={{ minHeight: '48px' }}>
          <div className="w-7 h-7 bg-gray-200 rounded-full"></div>
          <div className="w-7 h-7 bg-gray-200 rounded-full"></div>
          <div className="w-7 h-7 bg-gray-200 rounded-full"></div>
          <div className="w-7 h-7 bg-gray-200 rounded-full"></div>
        </div>
      </div>
    </div>
  );
}

// 首页骨架屏
export function HomePageSkeleton() {
  return (
    <div className="pb-20 animate-pulse">
      {/* 搜索栏 */}
      <div className="bg-emerald-600 p-3">
        <div className="h-10 bg-white rounded-full opacity-50"></div>
      </div>
      
      {/* 轮播图占位 */}
      <div className="px-3 pt-3">
        <div className="aspect-[2/1] bg-gray-200 rounded-2xl"></div>
      </div>
      
      {/* 功能卡片占位 */}
      <div className="px-3 pt-4 space-y-3">
        <div className="h-24 bg-gray-200 rounded-xl"></div>
        <div className="h-24 bg-gray-200 rounded-xl"></div>
        <div className="h-24 bg-gray-200 rounded-xl"></div>
      </div>
    </div>
  );
}

// 商城页骨架屏
export function MarketPageSkeleton() {
  return (
    <div className="pb-20 h-screen flex flex-col animate-pulse">
      {/* 搜索栏 */}
      <div className="bg-emerald-600 px-3 py-1.5 flex-shrink-0">
        <div className="h-10 bg-white rounded-full opacity-50"></div>
      </div>
      
      {/* 左侧分类 + 右侧商品 */}
      <div className="flex gap-0 flex-1">
        {/* 左侧分类栏 */}
        <div className="w-20 flex-shrink-0 bg-gray-50 space-y-2 p-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 bg-gray-200 rounded"></div>
          ))}
        </div>
        
        {/* 右侧商品网格 */}
        <div className="flex-1 p-3">
          <div className="grid grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-2">
                <div className="aspect-square bg-gray-200 rounded-xl"></div>
                <div className="h-4 bg-gray-200 rounded"></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// 社区页骨架屏（聊天：顶栏 + 左右消息条占位）
export function CommunityPageSkeleton() {
  return (
    <div className="pb-20 flex flex-col min-h-0 flex-1 animate-pulse">
      <div className="bg-emerald-600 safe-top flex-shrink-0 flex items-center gap-2 px-3 py-2 min-h-[48px]">
        <div className="w-9 h-9 rounded-full bg-white/30 flex-shrink-0" />
        <div className="flex-1 h-4 bg-white/40 rounded max-w-[50%] mx-auto" />
        <div className="w-8 h-8 rounded-full bg-white/20 flex-shrink-0" />
      </div>
      <div className="flex-1 min-h-0 px-3 py-4 space-y-3 overflow-hidden">
        <div className="flex justify-start">
          <div className="w-[72%] h-10 bg-gray-200 rounded-2xl rounded-tl-sm" />
        </div>
        <div className="flex justify-end">
          <div className="w-[65%] h-12 bg-emerald-200/90 rounded-2xl rounded-tr-sm" />
        </div>
        <div className="flex justify-start">
          <div className="w-[58%] h-9 bg-gray-200 rounded-2xl rounded-tl-sm" />
        </div>
        <div className="flex justify-end">
          <div className="w-[55%] h-10 bg-emerald-200/90 rounded-2xl rounded-tr-sm" />
        </div>
        <div className="flex justify-start">
          <div className="w-[68%] h-11 bg-gray-200 rounded-2xl rounded-tl-sm" />
        </div>
      </div>
    </div>
  );
}

/** 首页内 AI / 对账单 / 视频等懒加载子页共用占位 */
export function HomePageSecondaryLazySkeleton() {
  return (
    <div className="w-full h-full min-h-screen flex flex-col bg-white animate-pulse">
      <div className="bg-emerald-600 safe-top flex-shrink-0 flex items-center px-3 py-2 gap-3 min-h-[48px]">
        <div className="w-9 h-9 rounded-full bg-white/30 flex-shrink-0" />
        <div className="flex-1 h-4 bg-white/35 rounded max-w-[45%] mx-auto" />
        <div className="w-9 h-9 rounded-full bg-white/20 flex-shrink-0" />
      </div>
      <div className="flex-1 p-4 space-y-3">
        <div className="h-4 bg-gray-200 rounded w-4/5" />
        <div className="h-36 bg-gray-200 rounded-xl" />
        <div className="h-4 bg-gray-200 rounded w-3/5" />
        <div className="h-28 bg-gray-200 rounded-xl" />
      </div>
    </div>
  );
}

// 个人中心骨架屏
export function ProfilePageSkeleton() {
  return (
    <div className="pb-20 animate-pulse">
      {/* 用户信息区 */}
      <div className="bg-gradient-to-b from-emerald-600 to-emerald-500 p-6">
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 bg-white/30 rounded-full"></div>
          <div className="flex-1 space-y-2">
            <div className="h-6 bg-white/30 rounded w-1/2"></div>
            <div className="h-4 bg-white/30 rounded w-1/3"></div>
          </div>
        </div>
      </div>
      
      {/* 菜单项 */}
      <div className="mt-4 mx-3 space-y-2">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-14 bg-gray-200 rounded-xl"></div>
        ))}
      </div>
    </div>
  );
}