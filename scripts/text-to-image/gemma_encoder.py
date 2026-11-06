# SPDX-License-Identifier: Apache-2.0
# Copyright (c) 2026 UtopiaIA
#
import math

import torch
from torch import nn

class RMS(nn.Module):
    def __init__(self, w, eps):
        super().__init__()
        self.w, self.eps = nn.Parameter(w.float()), eps

    def forward(self, x):
        v = x.pow(2).mean(-1, keepdim=True)
        return x * torch.rsqrt(v + self.eps) * (1.0 + self.w)

class Layer(nn.Module):
    def __init__(self, sd, i, cfg):
        super().__init__()
        p = f'layers.{i}.'
        L = lambda n: nn.Parameter(sd[p + n].float())
        self.q, self.k, self.v, self.o = (L(f'self_attn.{n}_proj.weight') for n in 'qkvo')
        self.gate, self.up, self.down = (L(f'mlp.{n}_proj.weight') for n in ('gate', 'up', 'down'))
        eps = cfg['rms_norm_eps']
        self.n1, self.n2, self.n3, self.n4 = (RMS(sd[p + n + '.weight'], eps) for n in
                                              ('input_layernorm', 'post_attention_layernorm', 'pre_feedforward_layernorm', 'post_feedforward_layernorm'))
        self.h, self.kv, self.d = cfg['num_attention_heads'], cfg['num_key_value_heads'], cfg['head_dim']
        self.scale = cfg['query_pre_attn_scalar'] ** -0.5
        self.cap = cfg['attn_logit_softcapping']

    def forward(self, x, cos, sin, mask):
        B, T, _ = x.shape
        r = x
        x = self.n1(x)
        q = (x @ self.q.t()).view(B, T, self.h, self.d).transpose(1, 2)
        k = (x @ self.k.t()).view(B, T, self.kv, self.d).transpose(1, 2)
        v = (x @ self.v.t()).view(B, T, self.kv, self.d).transpose(1, 2)
        rot = lambda t: torch.cat((-t[..., self.d // 2:], t[..., :self.d // 2]), -1)
        q, k = q * cos + rot(q) * sin, k * cos + rot(k) * sin
        rep = self.h // self.kv
        k, v = k.repeat_interleave(rep, 1), v.repeat_interleave(rep, 1)
        s = (q @ k.transpose(-1, -2)) * self.scale
        s = torch.tanh(s / self.cap) * self.cap + mask
        a = torch.softmax(s, -1) @ v
        x = a.transpose(1, 2).reshape(B, T, self.h * self.d) @ self.o.t()
        x = r + self.n2(x)
        r = x
        x = self.n3(x)
        x = nn.functional.gelu(x @ self.gate.t(), approximate='tanh') * (x @ self.up.t())
        x = self.n4(x @ self.down.t())
        return r + x

class GemmaEncoder(nn.Module):
    def __init__(self, sd, cfg):
        super().__init__()
        self.layers = nn.ModuleList(Layer(sd, i, cfg) for i in range(cfg['num_hidden_layers']))
        self.norm = RMS(sd['norm.weight'], cfg['rms_norm_eps'])
        self.d, self.theta, self.mult = cfg['head_dim'], cfg['rope_theta'], math.sqrt(cfg['hidden_size'])

    def forward(self, embeds):
        T = embeds.shape[1]
        x = embeds * self.mult
        pos = torch.arange(T, dtype=torch.float32)
        inv = 1.0 / (self.theta ** (torch.arange(0, self.d, 2, dtype=torch.float32) / self.d))
        f = pos[:, None] * inv[None]
        e = torch.cat((f, f), -1)
        cos, sin = e.cos()[None, None], e.sin()[None, None]
        i = torch.arange(T)
        mask = torch.where(i[None, :] > i[:, None], torch.tensor(-1e9), torch.tensor(0.0))[None, None]
        for l in self.layers:
            x = l(x, cos, sin, mask)
        return self.norm(x)
