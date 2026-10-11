/**
 * OPFS 同步访问句柄互斥获取工具
 *
 * 同一个opfs在同一时间只允许存在一个同步访问句柄或可写流. bpm分析与频谱图worker共用该文件
 * 并通过BroadcastChannel发布 DEMAND_LOCK / OPFS_RELEASED做互斥协调.
 *
 * 拿不到锁时 该工具会
 * 1 广播DEMAND_LOCK 提示当前持有者释放
 * 2 短暂延迟后重试 直至拿到句柄或达到上限
 *
 * 之所以要带延迟的重试 是因为持有者可能已经随页面刷新/切换音频被销毁
 * 其留下的句柄只能等浏览器自行释放 这一般需要一小段时间
 * 单次立即重试会撞上尚未释放的旧句柄而失败
 */
export async function acquireOpfsAccessHandle(
	fileHandle: FileSystemFileHandle,
	opfsChannel: BroadcastChannel,
	maxRetries = 40,
	retryDelayMs = 300,
): Promise<FileSystemSyncAccessHandle> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fileHandle.createSyncAccessHandle();
		} catch (e) {
			lastError = e;
			if ((e as Error).name !== "NoModificationAllowedError") throw e;
			opfsChannel.postMessage("DEMAND_LOCK");
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
		}
	}
	throw lastError ?? new Error("Failed to acquire OPFS access handle");
}