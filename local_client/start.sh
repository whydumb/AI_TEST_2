#!/bin/bash
# Andy API Local Client Startup Script

echo "🚀 Andy API Local Client Launcher"
echo ""
echo "Available modes:"
echo "  web      - Web interface (default)"
echo "  cli      - Command-line client"
echo "  enhanced - Enhanced CLI client with VRAM monitoring"
echo ""

# Check if Python 3 is installed
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 is not installed. Please install Python 3 to continue."
    exit 1
fi

# Check if pip is installed
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 is not installed. Please install pip3 to continue."
    exit 1
fi

# Install requirements if not already installed
echo "📦 Installing requirements..."
pip3 install -r requirements.txt

# Check if Ollama is running
echo "🔍 Checking Ollama connection..."
if curl -s http://localhost:11434/api/tags > /dev/null; then
    echo "✅ Ollama is running"
else
    echo "⚠️ Warning: Ollama is not responding at localhost:11434"
    echo "   Please make sure Ollama is installed and running."
    echo "   Visit https://ollama.ai for installation instructions."
fi

# Parse command line arguments for mode
MODE="${1:-web}"

case "$MODE" in
    "web")
        echo "🌐 Starting Andy API Local Client Web Interface on http://localhost:5000"
        echo "   Dashboard: http://localhost:5000"
        echo "   Models: http://localhost:5000/models"
        echo "   Metrics: http://localhost:5000/metrics"
        echo "   Settings: http://localhost:5000/settings"
        ;;
    "cli")
        echo "💻 Starting Andy API Host Client (CLI mode)"
        ;;
    "enhanced")
        echo "🚀 Starting Enhanced Andy API Client (CLI mode)"
        ;;
    *)
        echo "❌ Unknown mode: $MODE"
        echo "Usage: $0 [web|cli|enhanced]"
        exit 1
        ;;
esac

echo ""
echo "Press Ctrl+C to stop the client"
echo ""

python3 launch.py --mode "$MODE"
