#!/usr/bin/env python3
"""
Andy API Local Client
A web-based interface for hosting Ollama models and connecting to the Andy API pool
"""

import os
import json
import time
import threading
import requests
from datetime import datetime, timedelta
from flask import Flask, render_template, request, jsonify, redirect, url_for
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional
import sqlite3
import logging

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = 'andy-local-client-secret-key'

# Configuration
CONFIG_FILE = 'client_config.json'
DB_FILE = 'local_client.db'
DEFAULT_ANDY_API_URL = 'https://mindcraft.riqvip.dev'
DEFAULT_OLLAMA_URL = 'http://localhost:11434'

@dataclass
class ModelConfig:
    name: str
    enabled: bool = False
    supports_embedding: bool = False
    supports_vision: bool = False
    supports_audio: bool = False
    max_concurrent: int = 2
    context_length: int = 4096
    quantization: str = "unknown"

@dataclass
class ClientStats:
    total_requests: int = 0
    successful_requests: int = 0
    failed_requests: int = 0
    total_tokens: int = 0
    average_tokens_per_second: float = 0.0
    last_request_time: Optional[datetime] = None
    uptime_start: datetime = datetime.now()

class LocalClient:
    def __init__(self):
        self.config = self.load_config()
        self.stats = ClientStats()
        self.models: Dict[str, ModelConfig] = {}
        self.is_connected = False
        self.host_id = None  # Store host_id for leave_pool calls
        self.connection_thread = None
        self.status_thread = None
        self.running = True
        self.init_database()
        
    def load_config(self) -> dict:
        """Load configuration from file"""
        default_config = {
            'andy_api_url': DEFAULT_ANDY_API_URL,
            'ollama_url': DEFAULT_OLLAMA_URL,
            'client_name': 'Local Andy Client',
            'api_key': '',
            'auto_connect': False,
            'report_interval': 30,
            'max_vram_gb': 8
        }
        
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r') as f:
                    config = json.load(f)
                    # Merge with defaults
                    default_config.update(config)
            except Exception as e:
                logger.error(f"Error loading config: {e}")
        
        return default_config
    
    def save_config(self):
        """Save configuration to file"""
        try:
            with open(CONFIG_FILE, 'w') as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving config: {e}")
    
    def init_database(self):
        """Initialize SQLite database for metrics"""
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                requests_per_minute INTEGER DEFAULT 0,
                avg_response_time REAL DEFAULT 0.0,
                tokens_per_second REAL DEFAULT 0.0,
                queue_length INTEGER DEFAULT 0,
                active_requests INTEGER DEFAULT 0,
                vram_used_gb REAL DEFAULT 0.0
            )
        ''')
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS request_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                model_name TEXT,
                request_type TEXT,
                tokens INTEGER DEFAULT 0,
                response_time REAL DEFAULT 0.0,
                success BOOLEAN DEFAULT 1
            )
        ''')
        
        conn.commit()
        conn.close()
    
    def discover_ollama_models(self) -> List[dict]:
        """Discover available Ollama models"""
        try:
            response = requests.get(f"{self.config['ollama_url']}/api/tags", timeout=10)
            if response.status_code == 200:
                data = response.json()
                return data.get('models', [])
        except Exception as e:
            logger.error(f"Error discovering Ollama models: {e}")
        return []
    
    def detect_model_capabilities(self, model_name: str) -> ModelConfig:
        """Detect model capabilities based on name and metadata"""
        model_config = ModelConfig(name=model_name)
        
        # Basic capability detection based on model name
        name_lower = model_name.lower()
        
        # Vision models
        if any(vision_indicator in name_lower for vision_indicator in ['llava', 'vision', 'clip', 'moondream']):
            model_config.supports_vision = True
        
        # Embedding models
        if any(embed_indicator in name_lower for embed_indicator in ['embed', 'bge', 'e5', 'sentence']):
            model_config.supports_embedding = True
        
        # Audio models (less common in Ollama but worth checking)
        if any(audio_indicator in name_lower for audio_indicator in ['whisper', 'audio', 'speech']):
            model_config.supports_audio = True
        
        # Try to get more detailed info from Ollama
        try:
            response = requests.post(
                f"{self.config['ollama_url']}/api/show",
                json={'name': model_name},
                timeout=10
            )
            if response.status_code == 200:
                model_info = response.json()
                # Extract context length and other details
                if 'model_info' in model_info:
                    params = model_info['model_info']
                    # This is model-specific and may need adjustment
                    model_config.context_length = params.get('context_length', 4096)
        except Exception as e:
            logger.warning(f"Could not get detailed info for {model_name}: {e}")
        
        return model_config
    
    def refresh_models(self):
        """Refresh the list of available models"""
        discovered = self.discover_ollama_models()
        new_models = {}
        
        for model_data in discovered:
            model_name = model_data['name']
            if model_name in self.models:
                # Keep existing configuration
                new_models[model_name] = self.models[model_name]
            else:
                # Detect capabilities for new models
                new_models[model_name] = self.detect_model_capabilities(model_name)
        
        self.models = new_models
        logger.info(f"Discovered {len(self.models)} models")
    
    def connect_to_pool(self):
        """Connect to the Andy API pool"""
        try:
            enabled_models = [
                {
                    'name': model.name,
                    'supports_embedding': model.supports_embedding,
                    'supports_vision': model.supports_vision,
                    'supports_audio': model.supports_audio,
                    'max_concurrent': model.max_concurrent,
                    'context_length': model.context_length,
                    'quantization': model.quantization
                }
                for model in self.models.values() if model.enabled
            ]
            
            payload = {
                'models': enabled_models,
                'max_clients': sum(model.max_concurrent for model in self.models.values() if model.enabled),
                'endpoint': self.config['ollama_url'],
                'capabilities': ['text'],  # Could be enhanced based on models
                'vram_total_gb': self.config.get('max_vram_gb', 0),
                'vram_used_gb': 0,  # Would need to implement actual VRAM monitoring
                'cpu_cores': 0,  # Could implement with psutil
                'ram_total_gb': 0,  # Could implement with psutil
                'ram_used_gb': 0,  # Could implement with psutil
            }
            
            response = requests.post(
                f"{self.config['andy_api_url']}/api/andy/join_pool",
                json={'info': payload},
                timeout=30
            )
            
            if response.status_code == 200:
                response_data = response.json()
                self.host_id = response_data.get('host_id')
                self.is_connected = True
                logger.info(f"Successfully connected to Andy API pool with host_id: {self.host_id}")
                return True
            else:
                logger.error(f"Failed to connect to pool: {response.status_code} - {response.text}")
                
        except Exception as e:
            logger.error(f"Error connecting to pool: {e}")
            
        self.is_connected = False
        return False
    
    def disconnect_from_pool(self):
        """Disconnect from the Andy API pool"""
        if not self.is_connected or not self.host_id:
            self.is_connected = False
            self.host_id = None
            return True
            
        try:
            response = requests.post(
                f"{self.config['andy_api_url']}/api/andy/leave_pool",
                json={'host_id': self.host_id},
                timeout=10
            )
            
            if response.status_code == 200:
                logger.info(f"Successfully disconnected from Andy API pool (host_id: {self.host_id})")
            else:
                logger.warning(f"Failed to disconnect from pool: {response.status_code} - {response.text}")
                
        except Exception as e:
            logger.error(f"Error disconnecting from pool: {e}")
        
        # Always reset connection state regardless of API call success
        self.is_connected = False
        self.host_id = None
        return True
    
    def report_status(self):
        """Report current status to the Andy API via ping_pool"""
        if not self.is_connected or not self.host_id:
            return
            
        try:
            # Calculate current metrics
            current_load = sum(1 for model in self.models.values() if model.enabled)
            
            payload = {
                'host_id': self.host_id,
                'current_load': current_load,
                'status': 'active',
                # Add system metrics if available
                'vram_used_gb': 0,  # Could implement with GPU monitoring
                'ram_used_gb': 0,   # Could implement with psutil
                'cpu_usage_percent': 0  # Could implement with psutil
            }
            
            response = requests.post(
                f"{self.config['andy_api_url']}/api/andy/ping_pool",
                json=payload,
                timeout=10
            )
            
            if response.status_code != 200:
                logger.warning(f"Failed to ping pool: {response.status_code}")
                
        except Exception as e:
            logger.error(f"Error pinging pool: {e}")
    
    def start_background_tasks(self):
        """Start background threads for connection and status reporting"""
        if self.config.get('auto_connect', True):
            self.connection_thread = threading.Thread(target=self._connection_loop, daemon=True)
            self.connection_thread.start()
        
        self.status_thread = threading.Thread(target=self._status_loop, daemon=True)
        self.status_thread.start()
    
    def _connection_loop(self):
        """Background thread for maintaining connection"""
        while self.running:
            if not self.is_connected:
                self.connect_to_pool()
            time.sleep(60)  # Check connection every minute
    
    def _status_loop(self):
        """Background thread for status reporting"""
        while self.running:
            if self.is_connected:
                self.report_status()
            time.sleep(self.config.get('report_interval', 30))
    
    def log_request(self, model_name: str, request_type: str, tokens: int, response_time: float, success: bool):
        """Log a request to the database"""
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            
            cursor.execute('''
                INSERT INTO request_log (model_name, request_type, tokens, response_time, success)
                VALUES (?, ?, ?, ?, ?)
            ''', (model_name, request_type, tokens, response_time, success))
            
            conn.commit()
            conn.close()
            
            # Update stats
            self.stats.total_requests += 1
            if success:
                self.stats.successful_requests += 1
                self.stats.total_tokens += tokens
                if response_time > 0:
                    self.stats.average_tokens_per_second = tokens / response_time
            else:
                self.stats.failed_requests += 1
                
            self.stats.last_request_time = datetime.now()
            
        except Exception as e:
            logger.error(f"Error logging request: {e}")

# Global client instance
client = LocalClient()

# Routes
@app.route('/')
def dashboard():
    """Main dashboard"""
    return render_template('local_dashboard.html', 
                         client=client, 
                         models=client.models,
                         stats=client.stats)

@app.route('/models')
def models():
    """Model configuration page"""
    return render_template('local_models.html', 
                         client=client, 
                         models=client.models)

@app.route('/metrics')
def metrics():
    """Metrics and analytics page"""
    # Calculate uptime in hours
    uptime_hours = ((datetime.now() - client.stats.uptime_start).total_seconds() / 3600)
    
    return render_template('local_metrics.html', 
                         client=client, 
                         stats=client.stats,
                         models=client.models,
                         uptime_hours=round(uptime_hours, 1))

@app.route('/settings')
def settings():
    """Settings page"""
    return render_template('local_settings.html', 
                         client=client, 
                         config=client.config)

@app.route('/api/refresh_models', methods=['POST'])
def api_refresh_models():
    """Refresh available models"""
    client.refresh_models()
    return jsonify({'success': True, 'models': len(client.models)})

@app.route('/api/toggle_model', methods=['POST'])
def api_toggle_model():
    """Toggle model enabled state"""
    data = request.get_json()
    model_name = data.get('model_name')
    
    if model_name in client.models:
        client.models[model_name].enabled = not client.models[model_name].enabled
        return jsonify({'success': True, 'enabled': client.models[model_name].enabled})
    
    return jsonify({'success': False, 'error': 'Model not found'}), 404

@app.route('/api/update_model', methods=['POST'])
def api_update_model():
    """Update model configuration"""
    data = request.get_json()
    model_name = data.get('model_name')
    
    if model_name in client.models:
        model = client.models[model_name]
        model.supports_embedding = data.get('supports_embedding', model.supports_embedding)
        model.supports_vision = data.get('supports_vision', model.supports_vision)
        model.supports_audio = data.get('supports_audio', model.supports_audio)
        model.max_concurrent = data.get('max_concurrent', model.max_concurrent)
        model.context_length = data.get('context_length', model.context_length)
        
        return jsonify({'success': True})
    
    return jsonify({'success': False, 'error': 'Model not found'}), 404

@app.route('/api/connect', methods=['POST'])
def api_connect():
    """Connect to Andy API pool"""
    success = client.connect_to_pool()
    return jsonify({'success': success, 'connected': client.is_connected})

@app.route('/api/disconnect', methods=['POST'])
def api_disconnect():
    """Disconnect from Andy API pool"""
    success = client.disconnect_from_pool()
    return jsonify({'success': success, 'connected': client.is_connected})

@app.route('/api/save_config', methods=['POST'])
def api_save_config():
    """Save configuration"""
    data = request.get_json()
    client.config.update(data)
    client.save_config()
    return jsonify({'success': True})

@app.route('/api/metrics_data')
def api_metrics_data():
    """Get metrics data for charts"""
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        # Get recent metrics (last 24 hours by default)
        hours = request.args.get('hours', 24, type=int)
        since = datetime.now() - timedelta(hours=hours)
        
        cursor.execute('''
            SELECT timestamp, requests_per_minute, avg_response_time, tokens_per_second, 
                   queue_length, active_requests, vram_used_gb
            FROM metrics 
            WHERE timestamp >= ? 
            ORDER BY timestamp
        ''', (since.isoformat(),))
        
        metrics = cursor.fetchall()
        conn.close()
        
        return jsonify({
            'metrics': metrics,
            'current_stats': {
                'total_requests': client.stats.total_requests,
                'successful_requests': client.stats.successful_requests,
                'failed_requests': client.stats.failed_requests,
                'average_tokens_per_second': client.stats.average_tokens_per_second,
                'uptime': (datetime.now() - client.stats.uptime_start).total_seconds(),
                'connected': client.is_connected,
                'enabled_models': len([m for m in client.models.values() if m.enabled])
            }
        })
        
    except Exception as e:
        logger.error(f"Error getting metrics data: {e}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    # Initialize models on startup
    client.refresh_models()
    client.start_background_tasks()
    
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)
