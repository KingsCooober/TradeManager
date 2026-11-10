package aiproviders

// 供应商模型目录 + 禁用黑名单（对齐 Jet Hub model.list / setDisabled 的黑名单制）：
//   - ModelCatalog 存「不过滤黑名单」的全量目录（含展示名），设置页据此渲染勾选，
//     这样被关掉的模型不会连同开关一起消失、用户永远能再打开；
//   - DisabledModels 只存被关掉的 model id，服务端新增模型默认显示；
//   - hub 的 /v1/models 与选号前校验用「全量 − 黑名单」得到启用集合。

import (
	"fmt"
	"sort"
	"strings"
)

// SetProviderCatalog 缓存一次远端模型发现的全量目录（不过滤黑名单）。
func (s *Store) SetProviderCatalog(providerID string, catalog []ModelInfo) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		seen := map[string]bool{}
		out := make([]ModelInfo, 0, len(catalog))
		for _, m := range catalog {
			id := strings.TrimSpace(m.ID)
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			name := strings.TrimSpace(m.Name)
			if name == "" {
				name = id
			}
			out = append(out, ModelInfo{ID: id, Name: name, Benefit: m.Benefit})
		}
		sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
		s.providers[i].ModelCatalog = out
		// 同步 CachedModels（hub 的 /v1/models 与 DefaultModel 兜底仍读它）。
		ids := make([]string, 0, len(out))
		for _, m := range out {
			ids = append(ids, m.ID)
		}
		s.providers[i].CachedModels = normalizeModels(ids)
		return s.persistLocked()
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

func isDisabled(list []string, id string) bool {
	for _, v := range list {
		if v == id {
			return true
		}
	}
	return false
}

// SetModelDisabled 单个模型开关（黑名单制：disabled=true 加入，false 移出）。
func (s *Store) SetModelDisabled(providerID, modelID string, disabled bool) error {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return fmt.Errorf("provider 与 modelId 必填")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		cur := s.providers[i].DisabledModels
		out := make([]string, 0, len(cur)+1)
		for _, v := range cur {
			if v != modelID {
				out = append(out, v)
			}
		}
		if disabled {
			out = append(out, modelID)
		}
		sort.Strings(out)
		if len(out) == 0 {
			out = nil
		}
		s.providers[i].DisabledModels = out
		return s.persistLocked()
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

// SetManyModelsDisabled 批量开关（组头全开/全关）。
func (s *Store) SetManyModelsDisabled(providerID string, modelIDs []string, disabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		set := map[string]bool{}
		for _, v := range s.providers[i].DisabledModels {
			set[v] = true
		}
		for _, id := range modelIDs {
			id = strings.TrimSpace(id)
			if id == "" {
				continue
			}
			if disabled {
				set[id] = true
			} else {
				delete(set, id)
			}
		}
		out := make([]string, 0, len(set))
		for id := range set {
			out = append(out, id)
		}
		sort.Strings(out)
		if len(out) == 0 {
			out = nil
		}
		s.providers[i].DisabledModels = out
		return s.persistLocked()
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

// SetAllModelsDisabled 全开/全关目录里的所有模型。
func (s *Store) SetAllModelsDisabled(providerID string, disabled bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		if !disabled {
			s.providers[i].DisabledModels = nil
			return s.persistLocked()
		}
		catalog := s.providers[i].ModelCatalog
		if len(catalog) == 0 {
			return fmt.Errorf("该供应商没有可关闭的模型，未做任何变更")
		}
		out := make([]string, 0, len(catalog))
		for _, m := range catalog {
			out = append(out, m.ID)
		}
		sort.Strings(out)
		s.providers[i].DisabledModels = out
		return s.persistLocked()
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}

// ProviderModels 给设置页：返回不过滤黑名单的全量目录 + 每行的 disabled 标记，
// 并把已禁用但已不在目录里的历史 id 补回（dead），让用户能重新打开。
func (s *Store) ProviderModels(providerID string) []ModelInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.providers {
		if p.ID != providerID {
			continue
		}
		disabled := map[string]bool{}
		for _, id := range p.DisabledModels {
			disabled[id] = true
		}
		catalog := p.ModelCatalog
		// 无缓存目录时用默认清单（codearts 冷启动）/ CachedModels / DefaultModel 兜底。
		if len(catalog) == 0 {
			ids := p.CachedModels
			if len(ids) == 0 && p.ID == ProviderCodeArts {
				ids = defaultCodeArtsModels
			}
			if len(ids) == 0 && p.DefaultModel != "" {
				ids = []string{p.DefaultModel}
			}
			catalog = make([]ModelInfo, 0, len(ids))
			for _, id := range ids {
				catalog = append(catalog, ModelInfo{ID: id, Name: id})
			}
		}
		out := make([]ModelInfo, 0, len(catalog)+len(disabled))
		seen := map[string]bool{}
		for _, m := range catalog {
			seen[m.ID] = true
			name := m.Name
			if name == "" {
				name = m.ID
			}
			out = append(out, ModelInfo{ID: m.ID, Name: name, Disabled: disabled[m.ID], Benefit: m.Benefit})
		}
		for id := range disabled {
			if !seen[id] {
				out = append(out, ModelInfo{ID: id, Name: id, Disabled: true, Dead: true})
			}
		}
		sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
		return out
	}
	return nil
}

// EnabledModelIDs 给 hub：返回「全量目录 − 黑名单」的启用模型 id 列表。
func (s *Store) EnabledModelIDs(providerID string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.providers {
		if p.ID != providerID {
			continue
		}
		ids := make([]string, 0, len(p.ModelCatalog))
		if len(p.ModelCatalog) > 0 {
			for _, m := range p.ModelCatalog {
				ids = append(ids, m.ID)
			}
		} else if len(p.CachedModels) > 0 {
			ids = append(ids, p.CachedModels...)
		}
		if len(ids) == 0 {
			if p.ID == ProviderCodeArts {
				ids = append(ids, defaultCodeArtsModels...)
			} else if p.DefaultModel != "" {
				ids = append(ids, p.DefaultModel)
			}
		}
		out := make([]string, 0, len(ids))
		for _, id := range ids {
			if !isDisabled(p.DisabledModels, id) {
				out = append(out, id)
			}
		}
		return out
	}
	return nil
}

// IsModelEnabled 选号前校验：禁用模型直接拒发，避免出现「对话框看不到但网关还能调」。
func (s *Store) IsModelEnabled(providerID, modelID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.providers {
		if p.ID == providerID {
			return !isDisabled(p.DisabledModels, modelID)
		}
	}
	return false
}

// CodeArtsBenefitModel 只读远端目录或自愈学习到的精确模型 id 标记。
func (s *Store) CodeArtsBenefitModel(providerID, modelID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.providers {
		if p.ID != providerID {
			continue
		}
		for _, model := range p.ModelCatalog {
			if model.ID == modelID {
				return model.Benefit
			}
		}
	}
	return false
}

// LearnCodeArtsBenefit 在一次双向纠错成功后保存精确 id 的通道，避免每次重试。
func (s *Store) LearnCodeArtsBenefit(providerID, modelID string, benefit bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.providers {
		if s.providers[i].ID != providerID {
			continue
		}
		for j := range s.providers[i].ModelCatalog {
			if s.providers[i].ModelCatalog[j].ID == modelID {
				if s.providers[i].ModelCatalog[j].Benefit == benefit {
					return nil
				}
				s.providers[i].ModelCatalog[j].Benefit = benefit
				return s.persistLocked()
			}
		}
		s.providers[i].ModelCatalog = append(s.providers[i].ModelCatalog, ModelInfo{ID: modelID, Name: modelID, Benefit: benefit})
		s.providers[i].CachedModels = normalizeModels(append(s.providers[i].CachedModels, modelID))
		return s.persistLocked()
	}
	return fmt.Errorf("供应商不存在：%s", providerID)
}
