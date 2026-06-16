#!/bin/bash

# Asstar项目统一管理脚本
# 支持网站部署、自动化设置、数据更新等功能

# 切换到仓库根目录运行（脚本现位于 scripts/ 下，内部路径均相对仓库根）
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 显示帮助信息
show_help() {
    echo -e "${CYAN}🚀 Asstar项目统一管理脚本${NC}"
    echo ""
    echo -e "${YELLOW}使用方法:${NC}"
    echo "  ./scripts/manage.sh [命令] [选项]"
    echo ""
    echo -e "${YELLOW}可用命令:${NC}"
    echo -e "  ${GREEN}deploy${NC}          - 部署网站到GitHub Pages"
    echo -e "  ${GREEN}setup${NC}           - 设置GitHub Action自动化功能"
    echo -e "  ${GREEN}update${NC}          - 手动更新数据"
    echo -e "  ${GREEN}test${NC}            - 测试所有功能"
    echo -e "  ${GREEN}status${NC}          - 显示项目状态"
    echo -e "  ${GREEN}help${NC}            - 显示此帮助信息"
    echo ""
    echo -e "${YELLOW}示例:${NC}"
    echo "  ./scripts/manage.sh deploy              # 部署网站"
    echo "  ./scripts/manage.sh setup               # 设置自动化"
    echo "  ./scripts/manage.sh update github       # 更新GitHub Trending数据"
    echo "  ./scripts/manage.sh update huggingface  # 更新HuggingFace数据"
    echo "  ./scripts/manage.sh update papers       # 更新HuggingFace Papers数据"
    echo "  ./scripts/manage.sh update focus        # 更新实时焦点数据（Tophub聚合）"
    echo "  ./scripts/manage.sh update all          # 更新所有数据"
    echo ""
}

# 检查Git仓库状态
check_git_repo() {
    if [ ! -d ".git" ]; then
        echo -e "${RED}❌ 错误: 当前目录不是Git仓库${NC}"
        echo "请确保在项目根目录中运行此脚本"
        exit 1
    fi
    echo -e "${GREEN}✅ Git仓库检查通过${NC}"
}

# 部署网站
deploy_website() {
    echo -e "${BLUE}🚀 开始部署Asstar网站到GitHub Pages...${NC}"
    
    check_git_repo
    
    # 添加所有文件
    echo -e "${CYAN}📁 添加文件到Git...${NC}"
    git add .
    
    # 提交更改
    echo -e "${CYAN}💾 提交更改...${NC}"
    git commit -m "Update Asstar website - $(date '+%Y-%m-%d %H:%M:%S')"
    
    # 推送到远程仓库
    echo -e "${CYAN}🌐 推送到GitHub...${NC}"
    git push origin main
    
    echo -e "${GREEN}✅ 部署完成！${NC}"
    echo -e "${YELLOW}📝 接下来请：${NC}"
    echo "1. 进入GitHub仓库设置"
    echo "2. 找到'Pages'选项"
    echo "3. 选择'Deploy from a branch'"
    echo "4. 选择main分支"
    echo "5. 保存设置"
    echo ""
    echo -e "${CYAN}🌍 网站将在几分钟后可通过 https://你的用户名.github.io/Asstar-X.github.io 访问${NC}"
}

# 设置GitHub Action自动化功能
setup_automation() {
    echo -e "${BLUE}🔧 设置GitHub Action自动化功能...${NC}"
    
    check_git_repo
    
    # 创建必要的目录
    echo -e "${CYAN}📁 创建必要的目录...${NC}"
    mkdir -p .github/workflows
    mkdir -p scripts
    
    # 检查关键文件是否存在
    echo -e "${CYAN}🔍 检查关键文件...${NC}"
    
    local missing_files=()
    
    if [ ! -f ".github/workflows/update-feeds.yml" ]; then
        missing_files+=(".github/workflows/update-feeds.yml")
    fi
    
    if [ ! -f "scripts/fetch_all.py" ]; then
        missing_files+=("scripts/fetch_all.py")
    fi
    
    if [ ${#missing_files[@]} -gt 0 ]; then
        echo -e "${RED}❌ 缺少以下关键文件:${NC}"
        for file in "${missing_files[@]}"; do
            echo "  - $file"
        done
        echo ""
        echo -e "${YELLOW}请确保所有必要的文件都已创建${NC}"
        exit 1
    fi
    
    # 设置文件权限
    echo -e "${CYAN}🔧 设置文件权限...${NC}"
    chmod +x scripts/fetch_all.py
    
    # 测试Python脚本
    echo -e "${CYAN}🧪 快速运行校验脚本（生成本地JSON）...${NC}"
    python3 scripts/fetch_all.py all || true
    
    # 提交更改
    echo -e "${CYAN}📝 提交更改到Git...${NC}"
    git add .
    git commit -m "Setup GitHub Action automation for trending data updates" || echo "没有新的更改需要提交"
    
    echo ""
    echo -e "${GREEN}🎉 GitHub Action自动化设置完成！${NC}"
    echo ""
    echo -e "${YELLOW}📋 下一步操作：${NC}"
    echo "1. 推送代码到GitHub: git push origin main"
    echo "2. 在GitHub仓库页面查看Actions标签页"
    echo "3. 手动触发一次工作流来测试功能"
    echo "4. 设置完成后："
    echo "   - GitHub Trending: 每天凌晨2点（UTC）自动更新"
    echo "   - HuggingFace: 每天凌晨3点（UTC）自动更新"
    echo ""
    echo -e "${YELLOW}📖 更多信息请查看：${NC}"
    echo "- scripts/README.md - 脚本使用说明"
    echo "- .github/workflows/ - 工作流配置"
}

# 更新数据
update_data() {
    local data_type="$1"
    
    python3 scripts/fetch_all.py "$data_type"
    
    # 提交更新
    echo -e "${CYAN}📝 提交数据更新...${NC}"
    git add .
    git commit -m "Update trending data - $(date '+%Y-%m-%d %H:%M:%S')"
    git push origin main
    
    echo -e "${GREEN}✅ 数据更新完成！${NC}"
}

# 测试所有功能
test_all() {
    echo -e "${BLUE}🧪 开始测试所有功能...${NC}"
    
    check_git_repo
    
    echo -e "${CYAN}测试GitHub Trending功能...${NC}"
    if python3 scripts/test_fetch.py; then
        echo -e "${GREEN}✅ GitHub Trending测试通过${NC}"
    else
        echo -e "${RED}❌ GitHub Trending测试失败${NC}"
    fi
    
    echo ""
    echo -e "${CYAN}测试HuggingFace功能...${NC}"
    if python3 scripts/test_huggingface.py; then
        echo -e "${GREEN}✅ HuggingFace测试通过${NC}"
    else
        echo -e "${RED}❌ HuggingFace测试失败${NC}"
    fi
    
    echo ""
    echo -e "${GREEN}🎉 所有测试完成！${NC}"
}

# 显示项目状态
show_status() {
    echo -e "${BLUE}📊 项目状态检查...${NC}"
    
    # Git状态
    if [ -d ".git" ]; then
        echo -e "${GREEN}✅ Git仓库: 已初始化${NC}"
        echo -e "${CYAN}  当前分支: $(git branch --show-current)${NC}"
        echo -e "${CYAN}  远程仓库: $(git remote get-url origin 2>/dev/null || echo '未设置')${NC}"
    else
        echo -e "${RED}❌ Git仓库: 未初始化${NC}"
    fi
    
    # 文件检查
    echo ""
    echo -e "${YELLOW}📁 关键文件检查:${NC}"
    
    local files=(
        ".github/workflows/update-feeds.yml"
        "scripts/fetch_all.py"
        "feeds/trending-data.json"
        "feeds/huggingface-data.json"
        "feeds/huggingface-papers-data.json"
        "feeds/realtime-focus.json"
    )
    
    for file in "${files[@]}"; do
        if [ -f "$file" ]; then
            echo -e "  ${GREEN}✅${NC} $file"
        else
            echo -e "  ${RED}❌${NC} $file"
        fi
    done
    
    # 数据状态
    echo ""
    echo -e "${YELLOW}📊 数据状态:${NC}"
    
    if [ -f "feeds/trending-data.json" ]; then
        local last_updated=$(grep -o '"lastUpdated"[[:space:]]*:[[:space:]]*"[^"]*"' feeds/trending-data.json | cut -d'"' -f4 2>/dev/null || echo "未知")
        echo -e "  ${CYAN}GitHub Trending:${NC} 最后更新 $last_updated"
    fi
    
    if [ -f "feeds/huggingface-data.json" ]; then
        local last_updated=$(grep -o '"lastUpdated"[[:space:]]*:[[:space:]]*"[^"]*"' feeds/huggingface-data.json | cut -d'"' -f4 2>/dev/null || echo "未知")
        echo -e "  ${CYAN}HuggingFace:${NC} 最后更新 $last_updated"
    fi
    if [ -f "feeds/huggingface-papers-data.json" ]; then
        local last_updated=$(grep -o '"lastUpdated"[[:space:]]*:[[:space:]]*"[^"]*"' feeds/huggingface-papers-data.json | cut -d'"' -f4 2>/dev/null || echo "未知")
        echo -e "  ${CYAN}HuggingFace Papers:${NC} 最后更新 $last_updated"
    fi
    
    if [ -f "feeds/realtime-focus.json" ]; then
        local saved_at=$(grep -m1 -o '"savedAt"[[:space:]]*:[[:space:]]*"[^"]*"' feeds/realtime-focus.json | cut -d'"' -f4 2>/dev/null || echo "未知")
        echo -e "  ${CYAN}Realtime Focus:${NC} 最后生成 $saved_at"
    fi
    
    echo ""
    echo -e "${GREEN}🎯 项目状态检查完成！${NC}"
}

# 主函数
main() {
    local command="$1"
    local option="$2"
    
    case "$command" in
        "deploy")
            deploy_website
            ;;
        "setup")
            setup_automation
            ;;
        "update")
            if [ -z "$option" ]; then
                echo -e "${RED}❌ 错误: 请指定要更新的数据类型${NC}"
                echo -e "${YELLOW}支持的类型: github, huggingface, all${NC}"
                exit 1
            fi
            update_data "$option"
            ;;
        "test")
            test_all
            ;;
        "status")
            show_status
            ;;
        "help"|"--help"|"-h"|"")
            show_help
            ;;
        *)
            echo -e "${RED}❌ 错误: 未知命令 '$command'${NC}"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

# 运行主函数
main "$@"
