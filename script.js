// 平滑滚动到指定部分
function scrollToSection(sectionId) {
    const target = document.getElementById(sectionId);
    if (target) {
        target.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
        });
    }
}

// Global GitHub auth widget
(function () {
    const apiRoot = 'https://cybertar-model-verify-api.1058996340.workers.dev';
    const tokenKey = 'cybertar:model-verifier:auth-token:v1';
    const tokenExpiresKey = 'cybertar:model-verifier:auth-token-expires-at:v1';
    const userKey = 'cybertar:model-verifier:auth-user:v1';
    const visitorKey = 'cybertar:site-visitor-id:v1';
    const statsCacheKey = 'cybertar:site-stats-cache:v1';
    const tokenTtlMs = 24 * 60 * 60 * 1000;
    let verifiedUser = null;

    function siteBaseUrl() {
        const script = document.currentScript || [...document.scripts].find((item) => /(?:^|\/)script\.js(?:\?|$)/.test(item.src || ''));
        try {
            const scriptUrl = new URL(script?.src || 'script.js', window.location.href);
            return new URL('.', scriptUrl);
        } catch {
            return new URL('./', window.location.href);
        }
    }

    function siteUrl(path) {
        return new URL(path, siteBaseUrl()).toString();
    }

    function storedToken() {
        const token = localStorage.getItem(tokenKey) || '';
        const expiresAt = Number(localStorage.getItem(tokenExpiresKey) || 0);
        if (!token) return '';
        if (!expiresAt) {
            localStorage.setItem(tokenExpiresKey, String(Date.now() + tokenTtlMs));
            return token;
        }
        if (expiresAt && Date.now() > expiresAt) {
            clearToken();
            return '';
        }
        return token;
    }

    function saveToken(token) {
        localStorage.setItem(tokenKey, token);
        localStorage.setItem(tokenExpiresKey, String(Date.now() + tokenTtlMs));
    }

    function clearToken() {
        localStorage.removeItem(tokenKey);
        localStorage.removeItem(tokenExpiresKey);
        localStorage.removeItem(userKey);
        verifiedUser = null;
    }

    function storedUser() {
        try {
            const user = JSON.parse(localStorage.getItem(userKey) || 'null');
            return user && typeof user === 'object' ? user : null;
        } catch {
            return null;
        }
    }

    function saveUser(user) {
        if (user) localStorage.setItem(userKey, JSON.stringify(user));
        else localStorage.removeItem(userKey);
    }

    function authHeaders() {
        const token = storedToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
    }

    function parseAuthRedirect() {
        const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const token = params.get('mv_auth_token');
        const error = params.get('mv_auth_error');
        if (token) {
            saveToken(token);
            history.replaceState(null, document.title, window.location.pathname + window.location.search);
            return { token };
        }
        if (error) {
            history.replaceState(null, document.title, window.location.pathname + window.location.search);
            return { error };
        }
        return {};
    }

    function startGitHubLogin() {
        const returnTo = encodeURIComponent(window.location.href.split('#')[0]);
        window.location.href = `${apiRoot}/model-verify-auth/github/login?return_to=${returnTo}`;
    }

    async function logout() {
        const token = storedToken();
        if (token) {
            await fetch(`${apiRoot}/model-verify-auth/logout`, {
                method: 'POST',
                headers: { ...authHeaders(), Accept: 'application/json' }
            }).catch(() => null);
        }
        clearToken();
        window.dispatchEvent(new CustomEvent('cybertar:auth-changed', { detail: { user: null, verified: true } }));
    }

    async function loadUser() {
        const token = storedToken();
        verifiedUser = null;
        if (!token) return null;
        try {
            const response = await fetch(`${apiRoot}/model-verify-auth/me`, {
                headers: { ...authHeaders(), Accept: 'application/json' },
                cache: 'no-store'
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.user) {
                clearToken();
                return null;
            }
            verifiedUser = payload.user;
            saveUser(payload.user);
            return payload.user;
        } catch {
            saveUser(null);
            return null;
        }
    }

    function injectStyles() {
        if (document.getElementById('cybertarAuthStyles')) return;
        const style = document.createElement('style');
        style.id = 'cybertarAuthStyles';
        style.textContent = `
            .cybertar-auth-widget {
                position: fixed;
                top: calc(2rem + 9px);
                right: calc(2rem + 72px);
                z-index: 2200;
                font-family: var(--font-display, 'Orbitron', sans-serif);
                background: transparent;
            }
            .header.cybertar-auth-dock {
                position: fixed;
                display: flex;
                align-items: center;
                gap: 1rem;
                background: transparent !important;
                border: 0 !important;
                box-shadow: none !important;
                backdrop-filter: none !important;
                -webkit-backdrop-filter: none !important;
            }
            .header.cybertar-auth-dock > .cybertar-auth-widget {
                position: static;
                margin-top: 0;
                flex: 0 0 auto;
                order: -1;
            }
            .header.cybertar-auth-dock > .nav,
            .cybertar-generated-nav {
                background: rgba(255, 255, 255, 0.055) !important;
                border-color: rgba(255, 255, 255, 0.16) !important;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28), inset 0 0 18px rgba(255, 255, 255, 0.035) !important;
            }
            .header.cybertar-auth-dock > .nav:hover,
            .cybertar-generated-nav:hover,
            .cybertar-generated-nav.is-open {
                background: rgba(8, 10, 14, 0.82) !important;
            }
            .nav.cybertar-auth-mobile-dock {
                justify-content: flex-start;
                position: relative;
            }
            .nav.cybertar-auth-mobile-dock .logo {
                margin-right: auto;
            }
            .nav.cybertar-auth-mobile-dock > .cybertar-auth-widget {
                position: static;
                margin: 0 0.7rem 0 auto;
                flex: 0 0 auto;
                z-index: 1001;
            }
            .header.cybertar-auth-dock > .cybertar-site-stats {
                position: absolute;
                top: calc(60px + 0.9rem);
                right: 0;
                margin-top: 0;
                flex: none;
                order: -2;
            }
            .nav.cybertar-auth-mobile-dock > .cybertar-site-stats {
                position: absolute;
                top: calc(100% + 0.9rem);
                right: 0.75rem;
                margin-left: 0;
                flex: none;
                z-index: 1001;
            }
            .nav.cybertar-auth-mobile-dock > .cybertar-site-stats + .cybertar-auth-widget {
                margin-left: 0;
            }
            .cybertar-auth-button {
                min-width: 74px;
                height: 42px;
                padding: 0 16px;
                border-radius: 999px;
                border: 1px solid rgba(124, 255, 0, 0.32);
                background: rgba(255, 255, 255, 0.055);
                color: rgba(255, 255, 255, 0.82);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25), inset 0 0 18px rgba(124, 255, 0, 0.05);
                backdrop-filter: blur(18px);
                -webkit-backdrop-filter: blur(18px);
                cursor: pointer;
                letter-spacing: 0.08rem;
                text-transform: uppercase;
                white-space: nowrap;
            }
            .cybertar-auth-button:hover,
            .cybertar-auth-button[aria-expanded="true"] {
                color: #fff;
                border-color: rgba(124, 255, 0, 0.74);
                box-shadow: 0 0 24px rgba(124, 255, 0, 0.18), inset 0 0 18px rgba(124, 255, 0, 0.06);
            }
            .cybertar-auth-menu {
                position: absolute;
                top: calc(100% + 0.55rem);
                right: 0;
                width: 220px;
                padding: 0.45rem;
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 10px;
                background: rgba(8, 10, 16, 0.96);
                color: #fff;
                box-shadow: 0 18px 60px rgba(0, 0, 0, 0.55);
                backdrop-filter: blur(18px);
                -webkit-backdrop-filter: blur(18px);
            }
            .cybertar-auth-menu[hidden] {
                display: none;
            }
            .cybertar-auth-menu-header {
                padding: 0.7rem 0.75rem;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                margin-bottom: 0.35rem;
            }
            .cybertar-auth-menu-header strong {
                display: block;
                font-size: 0.88rem;
            }
            .cybertar-auth-menu-header span {
                display: block;
                margin-top: 0.25rem;
                color: rgba(255, 255, 255, 0.58);
                font-size: 0.72rem;
                text-transform: uppercase;
                letter-spacing: 0.08rem;
            }
            .cybertar-auth-menu button,
            .cybertar-auth-menu a {
                display: block;
                width: 100%;
                padding: 0.68rem 0.75rem;
                border: 0;
                border-radius: 7px;
                background: transparent;
                color: rgba(255, 255, 255, 0.78);
                text-align: left;
                text-decoration: none;
                cursor: pointer;
                font: inherit;
                font-size: 0.82rem;
            }
            .cybertar-auth-menu button:hover,
            .cybertar-auth-menu a:hover {
                background: rgba(255, 255, 255, 0.08);
                color: #fff;
            }
            .cybertar-auth-modal {
                position: fixed;
                inset: 0;
                z-index: 3200;
                display: grid;
                place-items: center;
                padding: 1.25rem;
                background: rgba(0, 0, 0, 0.72);
                backdrop-filter: blur(14px);
                -webkit-backdrop-filter: blur(14px);
            }
            .cybertar-auth-modal[hidden] {
                display: none;
            }
            .cybertar-auth-dialog {
                width: min(420px, 100%);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 12px;
                background: rgba(8, 10, 16, 0.96);
                box-shadow: 0 24px 90px rgba(0, 0, 0, 0.65);
                color: #fff;
                overflow: hidden;
                font-family: var(--font-primary, sans-serif);
            }
            .cybertar-auth-dialog header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 1rem;
                padding: 1rem 1rem 0.75rem;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            }
            .cybertar-auth-dialog h2 {
                margin: 0;
                font-size: 1rem;
            }
            .cybertar-auth-close {
                width: 34px;
                height: 34px;
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.06);
                color: #fff;
                cursor: pointer;
            }
            .cybertar-auth-panel {
                display: grid;
                gap: 0.75rem;
                padding: 1rem;
            }
            .cybertar-auth-panel[hidden] {
                display: none;
            }
            .cybertar-auth-field {
                display: grid;
                gap: 0.32rem;
                color: rgba(255, 255, 255, 0.68);
                font-size: 0.82rem;
            }
            .cybertar-auth-field input {
                width: 100%;
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 8px;
                background: rgba(0, 0, 0, 0.32);
                color: #fff;
                padding: 0.74rem 0.82rem;
                outline: none;
            }
            .cybertar-auth-action {
                width: 100%;
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 8px;
                background: #fff;
                color: #000;
                padding: 0.78rem 0.9rem;
                cursor: pointer;
                font-weight: 700;
            }
            .cybertar-auth-action.secondary {
                background: rgba(255, 255, 255, 0.06);
                color: #fff;
            }
            .cybertar-auth-status {
                min-height: 1.2rem;
                color: rgba(255, 255, 255, 0.68);
                font-size: 0.84rem;
                line-height: 1.45;
            }
            .cybertar-site-stats {
                position: fixed;
                top: calc(2rem + 72px);
                right: 2rem;
                z-index: 2100;
                display: inline-flex;
                align-items: center;
                gap: 1.45rem;
                min-height: 42px;
                padding: 0.5rem 0.92rem;
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 999px;
                background: rgba(8, 10, 16, 0.82);
                color: rgba(255, 255, 255, 0.84);
                box-shadow: 0 14px 40px rgba(0, 0, 0, 0.36), inset 0 0 16px rgba(124, 255, 0, 0.035);
                backdrop-filter: blur(18px);
                -webkit-backdrop-filter: blur(18px);
                font-family: var(--font-display, var(--font-primary, sans-serif));
                font-size: 0.98rem;
                font-weight: 800;
                line-height: 1;
                letter-spacing: 0;
            }
            .cybertar-site-stats[hidden] {
                display: none;
            }
            .cybertar-site-stats span {
                display: inline-flex;
                align-items: baseline;
                gap: 0.34rem;
                white-space: nowrap;
            }
            .cybertar-site-stats strong {
                color: #fff;
                font-size: 1.12rem;
                font-weight: 900;
            }
            .cybertar-site-stats i {
                align-self: center;
                width: 0.56rem;
                height: 0.56rem;
                border-radius: 999px;
                background: #7cff00;
                box-shadow: 0 0 14px rgba(124, 255, 0, 0.68);
                font-style: normal;
            }
            .cybertar-site-stats.is-offline {
                border-color: rgba(255, 255, 255, 0.14);
                color: rgba(255, 255, 255, 0.84);
            }
            .cybertar-site-stats.is-offline i {
                background: #7cff00;
                box-shadow: 0 0 14px rgba(124, 255, 0, 0.68);
            }
            @media (max-width: 720px) {
                .cybertar-auth-widget {
                    top: 1rem;
                    right: 5rem;
                }
                .cybertar-auth-button {
                    height: 38px;
                    min-width: 64px;
                    padding: 0 12px;
                    font-size: 0.72rem;
                }
                .cybertar-site-stats {
                    top: 4.85rem;
                    right: 0.75rem;
                    gap: 0.92rem;
                    min-height: 38px;
                    padding: 0.42rem 0.68rem;
                    font-size: 0.82rem;
                }
                .cybertar-site-stats strong {
                    font-size: 0.96rem;
                }
            }
            .cybertar-generated-header {
                position: fixed;
                top: 2rem;
                right: 2rem;
                left: auto;
                width: auto;
                z-index: 1000;
                background: transparent;
            }
            .cybertar-generated-nav {
                display: flex;
                flex-direction: column;
                align-items: center;
                width: 60px;
                height: 60px;
                overflow: hidden;
                padding: 0.5rem;
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 30px;
                backdrop-filter: blur(24px);
                -webkit-backdrop-filter: blur(24px);
                transition: width 0.34s ease, height 0.34s ease, background 0.34s ease, box-shadow 0.34s ease;
            }
            .cybertar-generated-nav:hover,
            .cybertar-generated-nav.is-open {
                width: 160px;
                height: auto;
                max-height: 80vh;
                padding: 1.5rem 1rem;
            }
            .cybertar-generated-nav .logo {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 0.5rem;
                width: 100%;
                margin-bottom: 0.5rem;
                text-decoration: none;
                cursor: pointer;
            }
            .cybertar-generated-nav .logo-img {
                width: 42px;
                height: 42px;
                border-radius: 50%;
                object-fit: cover;
                border: 1px solid rgba(255, 255, 255, 0.22);
                box-shadow: 0 0 15px rgba(255, 255, 255, 0.08);
            }
            .cybertar-generated-nav .logo-text {
                height: 0;
                opacity: 0;
                overflow: hidden;
                color: #fff;
                font-weight: 700;
                font-size: 0;
                letter-spacing: 2px;
                white-space: nowrap;
                transition: all 0.25s ease;
            }
            .cybertar-generated-nav:hover .logo-text,
            .cybertar-generated-nav.is-open .logo-text {
                height: auto;
                opacity: 1;
                font-size: 0.9rem;
                margin-bottom: 1rem;
            }
            .cybertar-generated-nav .nav-links {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 0.8rem;
                width: 100%;
                margin: 0;
                padding: 0;
                list-style: none;
                opacity: 0;
                transform: translateY(-10px);
                transition: all 0.25s ease;
            }
            .cybertar-generated-nav:hover .nav-links,
            .cybertar-generated-nav.is-open .nav-links {
                opacity: 1;
                transform: translateY(0);
            }
            .cybertar-generated-nav .nav-link {
                display: block;
                width: 100%;
                padding: 0.2rem 0;
                border-radius: 4px;
                color: rgba(255, 255, 255, 0.68);
                text-align: center;
                text-decoration: none;
                font-size: 0.85rem;
                letter-spacing: 1px;
            }
            .cybertar-generated-nav .nav-link:hover {
                color: #fff;
                background: rgba(255, 255, 255, 0.08);
            }
            .cybertar-generated-nav .nav-toggle {
                display: none;
            }
        `;
        document.head.appendChild(style);
    }

    function ensureMainNavigation() {
        if (document.querySelector('.header .nav')) return;
        const header = document.createElement('header');
        header.className = 'header cybertar-generated-header';
        header.dataset.cybertarGeneratedNav = 'true';
        header.innerHTML = `
            <nav class="nav cybertar-generated-nav" aria-label="主导航">
                <a href="${siteUrl('index.html')}" class="logo" aria-label="CyberTAR 首页">
                    <img src="${siteUrl('images/Cybertar.png')}" alt="CyberTAR" class="logo-img">
                    <span class="logo-text">CYBERTAR</span>
                </a>
                <ul class="nav-links">
                    <li><a href="${siteUrl('index.html#home')}" class="nav-link">首页</a></li>
                    <li><a href="${siteUrl('blogs/index.html')}" class="nav-link">Blogs</a></li>
                    <li><a href="${siteUrl('index.html#projects')}" class="nav-link">AI Lab</a></li>
                    <li><a href="${siteUrl('space.html')}" class="nav-link">探索</a></li>
                    <li><a href="${siteUrl('trending-project.html')}" class="nav-link">Trending</a></li>
                    <li><a href="${siteUrl('lab/model-verifier.html')}" class="nav-link">模型验真</a></li>
                    <li><a href="${siteUrl('tools.html')}" class="nav-link">工具</a></li>
                </ul>
                <button class="nav-toggle" type="button" aria-label="Toggle menu"><span></span><span></span><span></span></button>
            </nav>
        `;
        document.body.appendChild(header);
        const nav = header.querySelector('.nav');
        nav.addEventListener('click', (event) => {
            if (event.target.closest('.nav-toggle')) nav.classList.toggle('is-open');
        });
    }

    function authDockTarget() {
        const header = document.querySelector('.header');
        const nav = header?.querySelector('.nav');
        if (!header || !nav) return null;
        if (header.dataset.cybertarGeneratedNav === 'true') {
            return { container: header, before: nav, className: 'cybertar-auth-dock' };
        }
        if (window.matchMedia('(min-width: 769px)').matches) {
            return { container: header, before: nav, className: 'cybertar-auth-dock' };
        }
        const toggle = nav.querySelector('.nav-toggle');
        return toggle ? { container: nav, before: toggle, className: 'cybertar-auth-mobile-dock' } : null;
    }

    function createModal() {
        const modal = document.createElement('div');
        modal.className = 'cybertar-auth-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="cybertar-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="cybertarAuthTitle">
                <header>
                    <h2 id="cybertarAuthTitle">账户登录</h2>
                    <button class="cybertar-auth-close" type="button" aria-label="Close">x</button>
                </header>
                <section class="cybertar-auth-panel" data-auth-login-panel>
                    <button class="cybertar-auth-action" type="button" data-auth-github>GitHub 登录</button>
                    <label class="cybertar-auth-field">用户名
                        <input autocomplete="username">
                    </label>
                    <label class="cybertar-auth-field">密码
                        <input type="password" autocomplete="current-password">
                    </label>
                    <button class="cybertar-auth-action secondary" type="button" data-auth-password>用户名密码登录</button>
                    <button class="cybertar-auth-action secondary" type="button" data-auth-show-register>注册</button>
                    <p class="cybertar-auth-status" data-auth-status></p>
                </section>
                <section class="cybertar-auth-panel" data-auth-register-panel hidden>
                    <label class="cybertar-auth-field">用户名
                        <input autocomplete="username">
                    </label>
                    <label class="cybertar-auth-field">邮箱
                        <input type="email" autocomplete="email">
                    </label>
                    <label class="cybertar-auth-field">密码
                        <input type="password" autocomplete="new-password">
                    </label>
                    <button class="cybertar-auth-action" type="button" data-auth-register>创建账户</button>
                    <button class="cybertar-auth-action secondary" type="button" data-auth-back-login>返回登录</button>
                    <p class="cybertar-auth-status" data-auth-register-status>注册暂未开放。</p>
                </section>
            </div>
        `;
        document.body.appendChild(modal);

        const loginPanel = modal.querySelector('[data-auth-login-panel]');
        const registerPanel = modal.querySelector('[data-auth-register-panel]');
        const status = modal.querySelector('[data-auth-status]');
        const registerStatus = modal.querySelector('[data-auth-register-status]');
        const close = () => { modal.hidden = true; };
        const showLogin = () => {
            loginPanel.hidden = false;
            registerPanel.hidden = true;
            status.textContent = '';
        };
        const showRegister = () => {
            loginPanel.hidden = true;
            registerPanel.hidden = false;
            registerStatus.textContent = '注册暂未开放。';
        };

        modal.querySelector('[data-auth-github]').addEventListener('click', startGitHubLogin);
        modal.querySelector('[data-auth-password]').addEventListener('click', () => {
            status.textContent = '用户名密码登录暂未开放。';
        });
        modal.querySelector('[data-auth-show-register]').addEventListener('click', showRegister);
        modal.querySelector('[data-auth-register]').addEventListener('click', () => {
            registerStatus.textContent = '注册暂未开放。';
        });
        modal.querySelector('[data-auth-back-login]').addEventListener('click', showLogin);
        modal.querySelector('.cybertar-auth-close').addEventListener('click', close);
        modal.addEventListener('click', (event) => {
            if (event.target === modal) close();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close();
        });

        return {
            open() {
                showLogin();
                modal.hidden = false;
                modal.querySelector('[data-auth-github]').focus();
            }
        };
    }

    function createWidget() {
        if (document.getElementById('cybertarAuthWidget')) return;
        injectStyles();
        ensureMainNavigation();
        const modal = createModal();
        const widget = document.createElement('div');
        widget.id = 'cybertarAuthWidget';
        widget.className = 'cybertar-auth-widget';
        widget.innerHTML = `
            <button class="cybertar-auth-button" type="button" aria-haspopup="menu" aria-expanded="false">登录</button>
            <div class="cybertar-auth-menu" role="menu" hidden>
                <div class="cybertar-auth-menu-header">
                    <strong data-auth-name>访客</strong>
                    <span data-auth-role>未登录</span>
                </div>
                <a href="/lab/model-verifier/" role="menuitem">模型验真</a>
                <button type="button" role="menuitem" data-profile>个人资料</button>
                <button type="button" role="menuitem" data-groups>权限组</button>
                <button type="button" role="menuitem" data-logout>退出登录</button>
            </div>
        `;
        const dock = authDockTarget();
        if (dock) {
            dock.container.classList.add(dock.className);
            dock.container.insertBefore(widget, dock.before);
        } else {
            document.body.appendChild(widget);
        }

        const button = widget.querySelector('.cybertar-auth-button');
        const menu = widget.querySelector('.cybertar-auth-menu');
        const name = widget.querySelector('[data-auth-name]');
        const role = widget.querySelector('[data-auth-role]');
        let currentUser = null;

        const closeMenu = () => {
            menu.hidden = true;
            button.setAttribute('aria-expanded', 'false');
        };
        const render = (user) => {
            currentUser = user;
            closeMenu();
            if (!user) {
                button.textContent = '登录';
                name.textContent = '访客';
                role.textContent = '未登录';
                return;
            }
            button.textContent = `${user.login}${user.role === 'admin' ? ' - ADMIN' : ''}`;
            name.textContent = user.login || 'GitHub user';
            role.textContent = user.role === 'admin' ? '超级管理员' : '普通用户';
        };

        button.addEventListener('click', () => {
            if (!currentUser) {
                modal.open();
                return;
            }
            const open = menu.hidden;
            menu.hidden = !open;
            button.setAttribute('aria-expanded', String(open));
        });
        widget.querySelector('[data-profile]').addEventListener('click', () => {
            if (currentUser?.login) window.location.href = `https://github.com/${encodeURIComponent(currentUser.login)}`;
        });
        widget.querySelector('[data-groups]').addEventListener('click', () => {
            alert(currentUser?.role === 'admin' ? '权限组：超级管理员' : '权限组：普通用户');
        });
        widget.querySelector('[data-logout]').addEventListener('click', async () => {
            await logout();
            render(null);
        });
        document.addEventListener('click', (event) => {
            if (!widget.contains(event.target)) closeMenu();
        });
        window.addEventListener('cybertar:auth-changed', (event) => {
            render(event.detail?.user || null);
        });

        parseAuthRedirect();
        loadUser().then((user) => {
            render(user);
            if (user) saveUser(user);
            window.dispatchEvent(new CustomEvent('cybertar:auth-ready', { detail: { user, verified: true } }));
            window.dispatchEvent(new CustomEvent('cybertar:auth-changed', { detail: { user, verified: true } }));
        });
    }

    function compactNumber(value) {
        if (value === undefined || value === null || value === '') return '0';
        const number = Number(value || 0);
        if (!Number.isFinite(number)) return '0';
        return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(number)));
    }

    function cachedSiteStats() {
        try {
            const cached = JSON.parse(localStorage.getItem(statsCacheKey) || 'null');
            return cached && typeof cached === 'object' ? cached : null;
        } catch {
            return null;
        }
    }

    function saveSiteStats(stats) {
        try {
            localStorage.setItem(statsCacheKey, JSON.stringify({
                totalVisits: Number(stats?.totalVisits || 0),
                onlineVisitors: Number(stats?.onlineVisitors || 0),
                updatedAt: stats?.updatedAt || new Date().toISOString()
            }));
        } catch {
            // Ignore storage failures; stats are decorative.
        }
    }

    function siteVisitorId() {
        try {
            const existing = localStorage.getItem(visitorKey);
            if (/^[a-zA-Z0-9_-]{12,80}$/.test(existing || '')) return existing;
            const generated = (window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
                .replace(/[^a-zA-Z0-9_-]/g, '')
                .slice(0, 48);
            localStorage.setItem(visitorKey, generated);
            return generated;
        } catch {
            return '';
        }
    }

    async function postSiteStats(eventName) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(`${apiRoot}/site-stats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            cache: 'no-store',
            signal: controller.signal,
            body: JSON.stringify({
                event: eventName,
                page: window.location.pathname,
                visitorId: siteVisitorId()
            })
        }).finally(() => clearTimeout(timeoutId));
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.stats) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload.stats;
    }

    function renderSiteStats(widget, stats) {
        const visits = widget.querySelector('[data-site-visits]');
        const online = widget.querySelector('[data-site-online]');
        if (visits) visits.textContent = compactNumber(stats?.totalVisits);
        if (online) online.textContent = compactNumber(stats?.onlineVisitors);
        widget.classList.remove('is-offline');
        widget.title = stats?.updatedAt ? `Updated ${stats.updatedAt}` : '';
        widget.hidden = false;
        saveSiteStats(stats);
    }

    function createSiteStatsWidget() {
        if (document.getElementById('cybertarSiteStats')) return;
        injectStyles();
        ensureMainNavigation();
        const widget = document.createElement('div');
        widget.id = 'cybertarSiteStats';
        widget.className = 'cybertar-site-stats';
        widget.hidden = false;
        widget.setAttribute('aria-label', '站点访问统计');
        widget.innerHTML = `
            <span>总访问量 <strong data-site-visits>--</strong></span>
            <span><i aria-hidden="true"></i>在线 <strong data-site-online>--</strong></span>
        `;
        renderSiteStats(widget, cachedSiteStats() || { totalVisits: 0, onlineVisitors: 0 });
        const authWidget = document.getElementById('cybertarAuthWidget');
        const dock = authDockTarget();
        if (dock) {
            dock.container.classList.add(dock.className);
            dock.container.insertBefore(widget, authWidget || dock.before);
        } else {
            document.body.appendChild(widget);
        }

        const refresh = async (eventName = 'heartbeat') => {
            if (document.hidden && eventName !== 'view') return;
            try {
                renderSiteStats(widget, await postSiteStats(eventName));
            } catch (error) {
                renderSiteStats(widget, cachedSiteStats() || { totalVisits: 0, onlineVisitors: 0 });
                widget.classList.add('is-offline');
                widget.title = `统计接口暂不可用：${error?.message || 'unknown error'}`;
                widget.hidden = false;
            }
        };

        refresh('view');
        setInterval(() => refresh('heartbeat'), 15000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) refresh('heartbeat');
        });
    }

    window.CyberTARAuth = {
        apiRoot,
        tokenKey,
        tokenExpiresKey,
        userKey,
        visitorKey,
        tokenTtlMs,
        getToken: storedToken,
        getUser: () => verifiedUser,
        getCachedUser: storedUser,
        saveToken,
        saveUser,
        clearToken,
        authHeaders,
        loadUser,
        login: startGitHubLogin,
        logout
    };

    document.addEventListener('DOMContentLoaded', createWidget);
    document.addEventListener('DOMContentLoaded', createSiteStatsWidget);
})();

// 平滑滚动
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const selector = this.getAttribute('href');
        if (!selector || selector === '#') return;
        e.preventDefault();
        const target = document.querySelector(selector);
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// 视差滚动效果
// Canvas Background Implementation
class AntigravityBackground {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;

        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.mouse = { x: null, y: null, radius: 150 };
        this.particleCount = window.innerWidth < 768 ? 60 : 100;
        this.connectionDistance = 150;

        this.init();
        this.animate();
        this.handleResize();
        this.handleMouse();
    }

    init() {
        this.resize();
        this.createParticles();
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    createParticles() {
        this.particles = [];
        for (let i = 0; i < this.particleCount; i++) {
            this.particles.push({
                x: Math.random() * this.canvas.width,
                y: Math.random() * this.canvas.height,
                vx: (Math.random() - 0.5) * 0.5,
                vy: (Math.random() - 0.5) * 0.5,
                size: Math.random() * 2 + 1,
                color: Math.random() > 0.5 ? '#ffffff' : '#ffffff'
            });
        }
    }

    handleResize() {
        window.addEventListener('resize', () => {
            this.resize();
            this.createParticles();
        });
    }

    handleMouse() {
        window.addEventListener('mousemove', (e) => {
            this.mouse.x = e.x;
            this.mouse.y = e.y;
        });

        window.addEventListener('mouseleave', () => {
            this.mouse.x = null;
            this.mouse.y = null;
        });
    }

    drawParticles() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        for (let i = 0; i < this.particles.length; i++) {
            let p = this.particles[i];

            // Movement
            p.x += p.vx;
            p.y += p.vy;

            // Bounce off edges
            if (p.x < 0 || p.x > this.canvas.width) p.vx *= -1;
            if (p.y < 0 || p.y > this.canvas.height) p.vy *= -1;

            // Mouse interaction
            if (this.mouse.x != null) {
                let dx = this.mouse.x - p.x;
                let dy = this.mouse.y - p.y;
                let distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < this.mouse.radius) {
                    const forceDirectionX = dx / distance;
                    const forceDirectionY = dy / distance;
                    const force = (this.mouse.radius - distance) / this.mouse.radius;
                    const directionX = forceDirectionX * force * 3;
                    const directionY = forceDirectionY * force * 3;

                    p.x -= directionX;
                    p.y -= directionY;
                }
            }

            // Draw particle
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            this.ctx.fillStyle = p.color;
            this.ctx.fill();

            // Connect particles
            for (let j = i; j < this.particles.length; j++) {
                let p2 = this.particles[j];
                let dx = p.x - p2.x;
                let dy = p.y - p2.y;
                let distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < this.connectionDistance) {
                    this.ctx.beginPath();
                    this.ctx.strokeStyle = `rgba(255, 255, 255, ${1 - distance / this.connectionDistance})`;
                    this.ctx.lineWidth = 0.5;
                    this.ctx.moveTo(p.x, p.y);
                    this.ctx.lineTo(p2.x, p2.y);
                    this.ctx.stroke();
                }
            }
        }
    }

    animate() {
        this.drawParticles();
        requestAnimationFrame(this.animate.bind(this));
    }
}

// 导航栏滚动效果
window.addEventListener('scroll', () => {
    const header = document.querySelector('.header');
    if (header) {
        if (window.scrollY > 100) {
            header.style.background = 'rgba(10, 10, 10, 0.95)';
            header.style.boxShadow = '0 2px 20px rgba(255, 255, 255, 0.1)';
        } else {
            header.style.background = 'rgba(10, 10, 10, 0.9)';
            header.style.boxShadow = 'none';
        }
    }
});

// 元素进入视口时的动画
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
        }
    });
}, observerOptions);

// 为需要动画的元素添加观察
document.addEventListener('DOMContentLoaded', () => {
    const animatedElements = document.querySelectorAll('.project-card, .stat, .contact-item');

    animatedElements.forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(el);
    });
});

// 鼠标跟随效果
document.addEventListener('mousemove', (e) => {
    const cursor = document.createElement('div');
    cursor.className = 'cursor-trail';
    cursor.style.cssText = `
        position: fixed;
        width: 4px;
        height: 4px;
        background: #ffffff;
        border-radius: 50%;
        pointer-events: none;
        z-index: 9999;
        left: ${e.clientX}px;
        top: ${e.clientY}px;
        animation: cursorFade 0.5s ease-out forwards;
    `;

    document.body.appendChild(cursor);

    setTimeout(() => {
        cursor.remove();
    }, 500);
});

// 添加CSS动画
const style = document.createElement('style');
style.textContent = `
    @keyframes cursorFade {
        0% {
            opacity: 1;
            transform: scale(1);
        }
        100% {
            opacity: 0;
            transform: scale(0);
        }
    }
`;
document.head.appendChild(style);

// 按钮点击效果
document.querySelectorAll('.btn').forEach(button => {
    button.addEventListener('click', function (e) {
        const ripple = document.createElement('span');
        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = e.clientX - rect.left - size / 2;
        const y = e.clientY - rect.top - size / 2;

        ripple.style.cssText = `
            position: absolute;
            width: ${size}px;
            height: ${size}px;
            left: ${x}px;
            top: ${y}px;
            background: rgba(255, 255, 255, 0.3);
            border-radius: 50%;
            transform: scale(0);
            animation: ripple 0.6s ease-out;
            pointer-events: none;
        `;

        this.appendChild(ripple);

        setTimeout(() => {
            ripple.remove();
        }, 600);
    });
});

// 添加涟漪动画CSS
const rippleStyle = document.createElement('style');
rippleStyle.textContent = `
    @keyframes ripple {
        to {
            transform: scale(4);
            opacity: 0;
        }
    }
`;
document.head.appendChild(rippleStyle);

// 打字机效果
function typeWriter(element, text, speed = 100) {
    let i = 0;
    element.innerHTML = '';

    function type() {
        if (i < text.length) {
            element.innerHTML += text.charAt(i);
            i++;
            setTimeout(type, speed);
        }
    }

    type();
}

// 通用 Skeleton 加载生成器
window.generateSkeleton = function(count = 6) {
    let items = '';
    for (let i = 0; i < count; i++) {
        items += `
            <div class="skeleton-card">
                <div class="skeleton-shimmer"></div>
                <div class="skeleton-item skeleton-title"></div>
                <div class="skeleton-item skeleton-line"></div>
                <div class="skeleton-item skeleton-line"></div>
                <div class="skeleton-item skeleton-line short"></div>
            </div>
        `;
    }
    return `
        <div class="loading-container">
            <div class="digital-pulse"><div></div><div></div></div>
            <p class="loading-text">正在同步量子数据...</p>
        </div>
        <div class="skeleton-grid">
            ${items}
        </div>
    `;
};

// 页面加载完成后的初始化
document.addEventListener('DOMContentLoaded', () => {
    // 为标题添加打字机效果
    const heroTitle = document.querySelector('.hero-title');
    if (heroTitle) {
        const originalText = heroTitle.textContent;
        typeWriter(heroTitle, originalText, 150);
    }

    // 添加粒子效果
    // Init Canvas Background
    new AntigravityBackground('canvas-background');
    loadProjects();

    // 汉堡菜单交互
    const navToggle = document.querySelector('.nav-toggle');
    const navLinks = document.querySelector('.nav-links');

    if (navToggle && navLinks) {
        navToggle.addEventListener('click', () => {
            navLinks.classList.toggle('open');
            // 添加汉堡按钮动画效果
            navToggle.classList.toggle('active');
        });

        // 点击导航链接后关闭菜单
        navLinks.addEventListener('click', (e) => {
            if (e.target.classList.contains('nav-link')) {
                navLinks.classList.remove('open');
                navToggle.classList.remove('active');
            }
        });

        // 点击页面其他区域关闭菜单
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('nav-link')) {
                navLinks.classList.remove('open');
                navToggle.classList.remove('active');
            }
        });
    }

    // 关于区域交互感：光晕随鼠标移动
    const aboutSection = document.querySelector('.about');
    const aboutAura = document.querySelector('.about-aura');
    if (aboutSection && aboutAura) {
        aboutSection.addEventListener('mousemove', (e) => {
            const rect = aboutSection.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            // 计算偏移量
            const moveX = (x / rect.width - 0.5) * 50;
            const moveY = (y / rect.height - 0.5) * 50;

            gsap.to(aboutAura, {
                x: moveX,
                y: moveY,
                duration: 2,
                ease: "power2.out"
            });
        });
    }
});



// 添加滚动进度指示器
function createScrollProgress() {
    const progressBar = document.createElement('div');
    progressBar.className = 'scroll-progress';
    progressBar.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 0%;
        height: 3px;
        background: linear-gradient(90deg, #ffffff, #000000);
        z-index: 1001;
        transition: width 0.1s ease;
    `;

    document.body.appendChild(progressBar);

    window.addEventListener('scroll', () => {
        const scrollTop = window.pageYOffset;
        const docHeight = document.body.scrollHeight - window.innerHeight;
        const scrollPercent = (scrollTop / docHeight) * 100;
        progressBar.style.width = scrollPercent + '%';
    });
}

// 初始化滚动进度条
createScrollProgress();

// 通用项目加载函数
function loadProjects(gridId, maxShow = 3) {
    fetch('/projects/list.json')
        .then(res => res.json())
        .then(projectFiles => {
            const grid = document.getElementById(gridId);
            if (!grid) return;
            grid.innerHTML = '';
            for (let i = 0; i < Math.min(maxShow, projectFiles.length); i++) {
                const card = document.createElement('div');
                card.className = 'project-card';
                const fileName = projectFiles[i].replace(/\.md$/, '');
                card.innerHTML = `
                    <div class="project-visual"><div class="project-orb"></div></div>
                    <h3>${fileName}</h3>
                `;
                card.style.cursor = 'pointer';
                card.onclick = function () {
                    window.location.href = `/project-view/?file=/projects/${encodeURIComponent(projectFiles[i])}`;
                };
                grid.appendChild(card);
            }
            // 显示或隐藏查看更多内容按钮
            const moreContainer = document.getElementById('more-projects-container');
            if (moreContainer) {
                if (projectFiles.length > maxShow) {
                    moreContainer.style.display = '';
                    const btn = document.getElementById('more-projects-btn');
                    if (btn) {
                        btn.onclick = function () {
                            window.location.href = '/projects/';
                        };
                    }
                } else {
                    moreContainer.style.display = 'none';
                }
            }
        });
}

/* ===== Cosmic Universe Background (Three.js) ===== */
class CosmicUniverse {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container || typeof THREE === 'undefined') return;

        this.init();
        this.animate();
        this.handleResize();
    }

    init() {
        // Scene & Fog
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x050505, 0.002);

        // Camera
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.camera.position.z = 5;

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        // Clock
        this.clock = new THREE.Clock();

        // Particles Layer 1
        const particlesGeometry = new THREE.BufferGeometry();
        const particlesCount = 3000;
        const posArray = new Float32Array(particlesCount * 3);
        const sizesArray = new Float32Array(particlesCount);

        for (let i = 0; i < particlesCount * 3; i++) {
            posArray[i] = (Math.random() - 0.5) * 25;
        }
        for (let i = 0; i < particlesCount; i++) {
            sizesArray[i] = Math.random();
        }

        particlesGeometry.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
        particlesGeometry.setAttribute('size', new THREE.BufferAttribute(sizesArray, 1));

        const material = new THREE.PointsMaterial({
            size: 0.03,
            color: 0xffffff,
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending
        });

        this.particlesMesh = new THREE.Points(particlesGeometry, material);
        this.scene.add(this.particlesMesh);

        // Particles Layer 2 (Blue Stars)
        const bgStarsGeometry = new THREE.BufferGeometry();
        const bgStarsCount = 5000;
        const bgPosArray = new Float32Array(bgStarsCount * 3);
        for (let i = 0; i < bgStarsCount * 3; i++) {
            bgPosArray[i] = (Math.random() - 0.5) * 80;
        }
        bgStarsGeometry.setAttribute('position', new THREE.BufferAttribute(bgPosArray, 3));

        const starsMaterial = new THREE.PointsMaterial({
            size: 0.05,
            color: 0x88ccff,
            transparent: true,
            opacity: 0.6,
            blending: THREE.AdditiveBlending
        });

        this.bgStarsMesh = new THREE.Points(bgStarsGeometry, starsMaterial);
        this.scene.add(this.bgStarsMesh);

        // Mouse interaction state
        this.mouseX = 0;
        this.mouseY = 0;
        document.addEventListener('mousemove', (e) => {
            this.mouseX = e.clientX - window.innerWidth / 2;
            this.mouseY = e.clientY - window.innerHeight / 2;
        });

        // Intro Animation
        if (typeof gsap !== 'undefined') {
            gsap.from(this.camera.position, {
                z: 10,
                duration: 3,
                ease: "power3.inOut"
            });
        }
    }

    handleResize() {
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    animate() {
        const elapsedTime = this.clock.getElapsedTime();

        // Rotation
        this.particlesMesh.rotation.y = elapsedTime * 0.05;
        this.particlesMesh.rotation.x = elapsedTime * 0.02;
        this.bgStarsMesh.rotation.y = elapsedTime * 0.01;

        // Parallax
        const targetX = this.mouseX * 0.001;
        const targetY = this.mouseY * 0.001;
        this.particlesMesh.rotation.y += 0.5 * (targetX - this.particlesMesh.rotation.y);
        this.particlesMesh.rotation.x += 0.05 * (targetY - this.particlesMesh.rotation.x);

        this.camera.position.x += (this.mouseX * 0.005 - this.camera.position.x) * 0.05;
        this.camera.position.y += (-this.mouseY * 0.005 - this.camera.position.y) * 0.05;

        this.renderer.render(this.scene, this.camera);
        requestAnimationFrame(() => this.animate());
    }
}

// Auto-initialize background if container exists
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('canvas-container')) {
        new CosmicUniverse('canvas-container');
    } else if (document.getElementById('canvas-background')) {
        // Some pages use 'canvas-background' ID
        const container = document.getElementById('canvas-background').parentElement;
        // In case 'canvas-background' is a container not a canvas
        const bgEl = document.getElementById('canvas-background');
        if (bgEl.tagName !== 'CANVAS') {
            new CosmicUniverse('canvas-background');
        } else {
            // If it IS a canvas, we might need a container or replace it.
            // For simplicity, let's assume it's a wrapper ID in most of our pages.
            new CosmicUniverse('canvas-background');
        }
    }
});
