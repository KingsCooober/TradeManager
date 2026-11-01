package httpapi

import (
	"context"
	"sync"
	"time"

	"easy-stock/backend/internal/foundation"
	"easy-stock/backend/internal/themeindex"
)

type adjustedHistoryFallback interface {
	AdjustedKLine(context.Context, string, int) ([]foundation.KLine, error)
}

type themeIndexHistory struct {
	primary    adjustedHistoryFallback
	fallback   adjustedHistoryFallback
	mu         sync.Mutex
	failures   int
	retryAfter time.Time
}

func (h *themeIndexHistory) load(ctx context.Context, symbol string, limit int) ([]foundation.KLine, error) {
	h.mu.Lock()
	tryPrimary := !time.Now().Before(h.retryAfter)
	h.mu.Unlock()
	if tryPrimary {
		// 单只 K 线正常耗时 0.8s 左右，128 只并发拉的时候经常被撑到 2s 以上。
		// 原来给 2s 会让「慢」被当成「挂」，三只就把熔断器打开，整批转去备用源。
		primaryCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		lines, err := h.primary.AdjustedKLine(primaryCtx, symbol, limit)
		timedOut := primaryCtx.Err() != nil
		cancel()
		lines = themeindex.CleanBars(lines, time.Now())
		h.mu.Lock()
		if err == nil && len(lines) >= 2 {
			h.failures = 0
			h.retryAfter = time.Time{}
			h.mu.Unlock()
			return lines, nil
		}
		// 超时只是慢，不代表数据源不可用，不能拿去累计熔断；
		// 连续 5 次「真失败」才认为主源挂了。
		if ctx.Err() == nil && !timedOut {
			h.failures++
			if h.failures >= 5 {
				h.retryAfter = time.Now().Add(60 * time.Second)
			}
		}
		h.mu.Unlock()
	}
	fallbackCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	return h.fallback.AdjustedKLine(fallbackCtx, symbol, limit)
}
