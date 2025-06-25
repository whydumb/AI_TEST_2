#!/usr/bin/env python3
"""
Andy API Local Client - Fixed Version
A web-based interface for hosting Ollama models and connecting to the Andy API pool
This version uses the new simple polling approach with check_for_work endpoint.
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
from urllib.parse import unquote
import uuid

# Optional imports for system monitoring
try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False
    
try:
    import GPUtil
    GPUTIL_AVAILABLE = True
except ImportError:
    GPUTIL_AVAILABLE = False

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
        self.models: Dict[str, ModelConfig] = {}
        self.stats = ClientStats()
        self.is_connected = False
        self.host_id = None
        self.running = False
        self.connection_thread = None
        self.status_thread = None
        self.work_thread = None
        self.client_uuid = self.load_or_create_uuid()
        
        # Initialize database
        self.init_database()
        
        # Discover models
        self.discover_models()

    def load_config(self) -> dict:
        """Load configuration from file and environment, log URLs used."""
        default_config = {
            'andy_api_url': DEFAULT_ANDY_API_URL,
            'ollama_url': DEFAULT_OLLAMA_URL,
            'auto_connect': False,
            'max_vram_gb': 0,
            'report_interval': 30
        }
        config = default_config.copy()
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r') as f:
                    file_config = json.load(f)
                    config.update(file_config)
            except Exception as e:
                logger.error(f"Error loading config: {e}")
        # Override with environment variables if set
        if 'ANDY_API_URL' in os.environ:
            config['andy_api_url'] = os.environ['ANDY_API_URL']
        if 'OLLAMA_URL' in os.environ:
            config['ollama_url'] = os.environ['OLLAMA_URL']
        # Log the URLs being used
        logger.info(f"Using Andy API URL: {config['andy_api_url']}")
        logger.info(f"Using Ollama URL: {config['ollama_url']}")
        # Warn if using localhost in a non-local environment
        if (not config['andy_api_url'].startswith('http://localhost') and
            'localhost' in config['andy_api_url']):
            logger.warning(f"Andy API URL is set to localhost, but you may be running in a non-local environment!")
        return config

    def save_config(self):
        """Save configuration to file"""
        try:
            with open(CONFIG_FILE, 'w') as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving config: {e}")

    def init_database(self):
        """Initialize SQLite database for logging"""
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute('''
                CREATE TABLE IF NOT EXISTS requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    model_name TEXT,
                    request_type TEXT,
                    tokens INTEGER,
                    response_time REAL,
                    success BOOLEAN
                )
            ''')
            conn.commit()
            conn.close()
        except Exception as e:
            logger.error(f"Database initialization error: {e}")

    def discover_models(self):
        """Discover available models from Ollama and enable the first one by default if none are enabled."""
        try:
            response = requests.get(f"{self.config['ollama_url']}/api/tags", timeout=10)
            if response.status_code == 200:
                data = response.json()
                current_models = set(self.models.keys())
                discovered_models = set()
                for model in data.get('models', []):
                    model_name = model['name']
                    discovered_models.add(model_name)
                    if model_name not in self.models:
                        self.models[model_name] = ModelConfig(
                            name=model_name,
                            enabled=False,
                            context_length=model.get('context_length', 4096),
                            quantization=model.get('quantization', 'unknown')
                        )
                # Remove models that are no longer available
                for model_name in current_models - discovered_models:
                    if model_name in self.models:
                        del self.models[model_name]
                # --- Enable the first model by default if none are enabled ---
                if not any(m.enabled for m in self.models.values()) and self.models:
                    first_model = next(iter(self.models.values()))
                    first_model.enabled = True
                    logger.info(f"Auto-enabled model: {first_model.name} for local testing.")
                logger.info(f"Discovered {len(self.models)} models")
            else:
                logger.error(f"Failed to discover models: {response.status_code}")
        except Exception as e:
            logger.error(f"Error discovering models: {e}")

    def load_or_create_uuid(self):
        uuid_file = 'client_uuid.txt'
        if os.path.exists(uuid_file):
            with open(uuid_file, 'r') as f:
                return f.read().strip()
        new_uuid = str(uuid.uuid4())
        with open(uuid_file, 'w') as f:
            f.write(new_uuid)
        return new_uuid

    def get_fresh_config(self) -> dict:
        """Always reload config from file and environment for every connection attempt."""
        default_config = {
            'andy_api_url': DEFAULT_ANDY_API_URL,
            'ollama_url': DEFAULT_OLLAMA_URL,
            'auto_connect': False,
            'max_vram_gb': 0,
            'report_interval': 30
        }
        config = default_config.copy()
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r') as f:
                    file_config = json.load(f)
                    config.update(file_config)
            except Exception as e:
                logger.error(f"Error loading config: {e}")
        if 'ANDY_API_URL' in os.environ:
            config['andy_api_url'] = os.environ['ANDY_API_URL']
        if 'OLLAMA_URL' in os.environ:
            config['ollama_url'] = os.environ['OLLAMA_URL']
        return config

    def connect_to_pool(self):
        """Connect to the Andy API pool with robust host detection and sync. Always reload config."""
        try:
            config = self.get_fresh_config()
            logger.info(f"Connecting to Andy API at: {config['andy_api_url']}")
            # Step 1: Get pool status before joining to record existing host IDs
            logger.info("Getting pool status before joining...")
            try:
                before_response = requests.get(
                    f"{config['andy_api_url']}/api/andy/pool_status",
                    timeout=10
                )
                before_host_ids = set()
                if before_response.status_code == 200:
                    before_data = before_response.json()
                    before_host_ids = {host['host_id'] for host in before_data.get('hosts', [])}
                    logger.info(f"Found {len(before_host_ids)} existing hosts in pool")
                else:
                    logger.warning(f"Failed to get initial pool status from {config['andy_api_url']}: {before_response.status_code}")
            except Exception as e:
                logger.warning(f"Error getting initial pool status from {config['andy_api_url']}: {e}")
                before_host_ids = set()
            # Step 2: Prepare join payload
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
                'endpoint': config['ollama_url'],
                'capabilities': ['text'],
                'vram_total_gb': config.get('max_vram_gb', 0),
                'vram_used_gb': 0,
                'gpu_compute_capability': 0,
                'cpu_cores': 0,
                'ram_total_gb': 0,
                'ram_used_gb': 0,
                'client_uuid': self.client_uuid  # Add persistent client UUID
            }
            # Step 3: Join the pool
            logger.info(f"Joining the pool at {config['andy_api_url']}...")
            response = requests.post(
                f"{config['andy_api_url']}/api/andy/join_pool",
                json={'info': payload},
                timeout=30
            )
            if response.status_code == 200:
                response_data = response.json()
                server_provided_host_id = response_data.get('host_id')
                logger.info(f"Server provided host_id: {server_provided_host_id}")
                # Step 4: Wait up to 60s for host to appear in pool (exponential backoff)
                logger.info("Waiting for host to appear in pool status (up to 60s)...")
                detected_host_id = None
                max_wait = 60
                wait = 0.5
                total_wait = 0
                while total_wait < max_wait:
                    try:
                        after_response = requests.get(
                            f"{config['andy_api_url']}/api/andy/pool_status",
                            timeout=10
                        )
                        if after_response.status_code == 200:
                            after_data = after_response.json()
                            after_host_ids = {host['host_id'] for host in after_data.get('hosts', [])}
                            new_host_ids = after_host_ids - before_host_ids
                            if len(new_host_ids) == 1:
                                detected_host_id = list(new_host_ids)[0]
                                logger.info(f"Detected our actual host_id: {detected_host_id} after {total_wait:.1f}s")
                                break
                            elif server_provided_host_id in after_host_ids:
                                detected_host_id = server_provided_host_id
                                logger.info(f"Server-provided host_id found in pool after {total_wait:.1f}s")
                                break
                            else:
                                logger.debug(f"Host not yet visible in pool after {total_wait:.1f}s, retrying...")
                        else:
                            logger.warning(f"Failed to get pool status after joining: {after_response.status_code}")
                    except Exception as e:
                        logger.warning(f"Error getting pool status after join: {e}")
                    time.sleep(wait)
                    total_wait += wait
                    wait = min(wait * 1.5, 10)  # Exponential backoff, max 10s
                if not detected_host_id:
                    logger.warning(f"Host not visible in pool after {max_wait}s, falling back to server-provided host_id: {server_provided_host_id}")
                    detected_host_id = server_provided_host_id
                self.host_id = detected_host_id
                self.is_connected = True
                # Step 5: Immediately ping to establish presence with our detected host ID
                logger.info("Sending initial ping to establish pool presence...")
                for attempt in range(5):
                    try:
                        time.sleep(0.5)
                        ping_payload = {
                            'host_id': self.host_id,
                            'current_load': sum(1 for model in self.models.values() if model.enabled),
                            'status': 'active',
                            'vram_used_gb': 0,
                            'ram_used_gb': 0,
                            'cpu_usage_percent': 0
                        }
                        ping_response = requests.post(
                            f"{config['andy_api_url']}/api/andy/ping_pool",
                            json=ping_payload,
                            timeout=10
                        )
                        if ping_response.status_code == 200:
                            logger.info(f"Initial ping successful on attempt {attempt + 1}")
                            break
                        elif ping_response.status_code == 404:
                            logger.warning(f"Host not found on ping attempt {attempt + 1}, retrying...")
                            continue
                        else:
                            logger.warning(f"Initial ping failed with status {ping_response.status_code}")
                    except Exception as e:
                        logger.warning(f"Initial ping attempt {attempt + 1} failed: {e}")
                        continue
                return True
            else:
                logger.error(f"Failed to connect to pool at {config['andy_api_url']}: {response.status_code} - {response.text}")
        except Exception as e:
            logger.error(f"Error connecting to pool at {getattr(self, 'config', {}).get('andy_api_url', 'unknown')}: {e}")
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
            
            if response.status_code == 200:
                logger.debug(f"Successfully pinged pool (host_id: {self.host_id})")
            elif response.status_code == 404:
                logger.warning(f"Host not found in pool (host_id: {self.host_id}), marking as disconnected")
                self.is_connected = False
                self.host_id = None
            else:
                logger.warning(f"Failed to ping pool: {response.status_code} - {response.text}")
                
        except Exception as e:
            logger.error(f"Error pinging pool: {e}")
            # Don't disconnect on network errors, just log and retry later

    def start_background_threads(self):
        """Start background threads for connection management and work polling"""
        if self.running:
            return
            
        self.running = True
        
        # Connection monitoring thread
        self.connection_thread = threading.Thread(target=self._connection_loop, daemon=True)
        self.connection_thread.start()
        
        # Status reporting thread
        self.status_thread = threading.Thread(target=self._status_loop, daemon=True)
        self.status_thread.start()
        
        # Work polling thread - now uses simple polling
        self.work_thread = threading.Thread(target=self._work_polling_loop, daemon=True)
        self.work_thread.start()
        
        logger.info("Background threads started")

    def stop_background_threads(self):
        """Stop background threads"""
        self.running = False
        logger.info("Background threads stopped")

    def _connection_loop(self):
        """Background thread for maintaining connection"""
        while self.running:
            # Check if we should be connected but aren't
            should_be_connected = any(model.enabled for model in self.models.values())
            
            if should_be_connected and not self.is_connected:
                logger.info("Attempting to connect to pool...")
                if self.connect_to_pool():
                    logger.info("Successfully reconnected to pool")
                else:
                    logger.warning("Failed to reconnect, will retry in 30 seconds")
                    time.sleep(30)
                    continue
            
            time.sleep(60)  # Check connection every minute

    def _status_loop(self):
        """Background thread for status reporting"""
        while self.running:
            if self.is_connected:
                self.report_status()
            time.sleep(self.config.get('report_interval', 30))

    def _work_polling_loop(self):
        """Background thread for simple polling work requests"""
        while self.running:
            if self.is_connected and self.host_id:
                try:
                    # Get enabled models
                    enabled_models = [
                        model.name for model in self.models.values() if model.enabled
                    ]
                    
                    if not enabled_models:
                        time.sleep(10)
                        continue
                    
                    # Simple polling for work (non-blocking)
                    payload = {
                        "host_id": self.host_id,
                        "models": enabled_models
                    }
                    
                    response = requests.post(
                        f"{self.config['andy_api_url']}/api/andy/check_for_work",
                        json=payload,
                        timeout=10  # Short timeout for simple polling
                    )
                    
                    if response.status_code == 200:
                        work_data = response.json()
                        work_id = work_data.get('work_id')
                        
                        if work_id:
                            logger.info(f"Received work: {work_id} for model {work_data.get('model')}")
                            self.process_work(work_id, work_data)
                    
                    elif response.status_code == 204:
                        # No work available, continue polling
                        pass
                    elif response.status_code == 404:
                        logger.warning("Host not registered, attempting to reconnect...")
                        self.is_connected = False
                        time.sleep(10)
                        continue
                    else:
                        logger.warning(f"Work poll failed: {response.status_code}")
                        time.sleep(5)
                        
                except requests.exceptions.Timeout:
                    logger.warning("Work polling timeout")
                    pass
                except Exception as e:
                    logger.error(f"Work polling error: {e}")
                    time.sleep(5)
                
                # Simple polling interval - wait 3 seconds between checks
                time.sleep(3)
            else:
                time.sleep(5)

    def process_work(self, work_id: str, work_data: dict):
        """Process assigned work"""
        try:
            model = work_data['model']
            messages = work_data['messages']
            params = work_data.get('params', {})
            
            # Check if we have this model enabled
            if model not in self.models or not self.models[model].enabled:
                self.submit_work_error(work_id, f"Model {model} not available")
                return
            
            # Make request to local Ollama
            ollama_payload = {
                "model": model,
                "messages": messages,
                **params
            }
            
            start_time = time.time()
            response = requests.post(
                f"{self.config['ollama_url']}/api/chat",
                json=ollama_payload,
                timeout=120
            )
            response_time = time.time() - start_time
            
            if response.status_code == 200:
                result = response.json()
                
                # Log successful request
                self.log_request(model, 'chat', 0, response_time, True)
                
                # Submit successful result
                self.submit_work_result(work_id, result)
            else:
                error_msg = f"Ollama request failed: {response.status_code}"
                logger.error(error_msg)
                self.log_request(model, 'chat', 0, response_time, False)
                self.submit_work_error(work_id, error_msg)
                
        except Exception as e:
            logger.error(f"Error processing work {work_id}: {e}")
            self.submit_work_error(work_id, str(e))

    def submit_work_result(self, work_id: str, result: dict):
        """Submit successful work result"""
        try:
            payload = {
                "work_id": work_id,
                "result": result
            }
            
            response = requests.post(
                f"{self.config['andy_api_url']}/api/andy/submit_work_result",
                json=payload,
                timeout=10
            )
            
            if response.status_code == 200:
                logger.info(f"Work completed: {work_id}")
            else:
                logger.warning(f"Failed to submit result: {response.status_code}")
                
        except Exception as e:
            logger.error(f"Error submitting work result: {e}")

    def submit_work_error(self, work_id: str, error: str):
        """Submit work error result"""
        try:
            payload = {
                "work_id": work_id,
                "error": error
            }
            
            response = requests.post(
                f"{self.config['andy_api_url']}/api/andy/submit_work_result",
                json=payload,
                timeout=10
            )
            
            if response.status_code == 200:
                logger.info(f"Work error submitted: {work_id}")
            else:
                logger.warning(f"Failed to submit error: {response.status_code}")
                
        except Exception as e:
            logger.error(f"Error submitting work error: {e}")

    def log_request(self, model_name: str, request_type: str, tokens: int, response_time: float, success: bool):
        """Log a request to the database"""
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute('''
                INSERT INTO requests (model_name, request_type, tokens, response_time, success)
                VALUES (?, ?, ?, ?, ?)
            ''', (model_name, request_type, tokens, response_time, success))
            conn.commit()
            conn.close()
            
            # Update stats
            self.stats.total_requests += 1
            if success:
                self.stats.successful_requests += 1
            else:
                self.stats.failed_requests += 1
            self.stats.total_tokens += tokens
            self.stats.last_request_time = datetime.now()
            
        except Exception as e:
            logger.error(f"Error logging request: {e}")

# Global client instance
client = LocalClient()

# Flask routes
@app.route('/')
def index():
    """Main dashboard"""
    return render_template('index.html',
                         models=client.models,
                         stats=asdict(client.stats),
                         config=client.config,
                         is_connected=client.is_connected,
                         host_id=client.host_id)
# Flask routes
@app.route('/models')
def models():
    """Models page"""
    return render_template('models.html',
                         models=client.models,
                         stats=asdict(client.stats),
                         config=client.config,
                         is_connected=client.is_connected,
                         host_id=client.host_id)
# Flask routes
@app.route('/metrics')
def metrics():
    """Metrics page"""
    return render_template('metrics.html',
                         models=client.models,
                         stats=asdict(client.stats),
                         config=client.config,
                         is_connected=client.is_connected,
                         host_id=client.host_id)

# Flask routes
@app.route('/settings')
def settings():
    """Settings page"""
    return render_template('settings.html',
                         models=client.models,
                         stats=asdict(client.stats),
                         config=client.config,
                         is_connected=client.is_connected,
                         host_id=client.host_id)

@app.route('/api/models')
def api_models():
    """Get models list"""
    return jsonify({
        model_name: asdict(model) for model_name, model in client.models.items()
    })

@app.route('/api/models/<path:model_name>/toggle', methods=['POST'])
def toggle_model(model_name):
    """Toggle model enabled state"""
    # URL decode the model name
    model_name = unquote(model_name)
    
    if model_name in client.models:
        client.models[model_name].enabled = not client.models[model_name].enabled
        logger.info(f"Model {model_name} {'enabled' if client.models[model_name].enabled else 'disabled'}")
        return jsonify({'success': True, 'enabled': client.models[model_name].enabled})
    return jsonify({'success': False, 'error': 'Model not found'}), 404

@app.route('/api/models/<path:model_name>/config', methods=['POST'])
def update_model_config(model_name):
    """Update model configuration"""
    # URL decode the model name
    model_name = unquote(model_name)
    
    if model_name not in client.models:
        return jsonify({'success': False, 'error': 'Model not found'}), 404
    
    data = request.get_json()
    model = client.models[model_name]
    
    # Update configurable fields
    if 'max_concurrent' in data:
        model.max_concurrent = max(1, min(10, int(data['max_concurrent'])))
    if 'context_length' in data:
        model.context_length = max(512, min(32768, int(data['context_length'])))
    if 'supports_embedding' in data:
        model.supports_embedding = bool(data['supports_embedding'])
    if 'supports_vision' in data:
        model.supports_vision = bool(data['supports_vision'])
    if 'supports_audio' in data:
        model.supports_audio = bool(data['supports_audio'])
    
    logger.info(f"Updated config for model {model_name}")
    return jsonify({'success': True})

@app.route('/api/discover_models', methods=['POST'])
def discover_models():
    """Rediscover models from Ollama"""
    client.discover_models()
    return jsonify({'success': True, 'model_count': len(client.models)})

@app.route('/api/connect', methods=['POST'])
def connect():
    """Connect to Andy API pool"""
    if client.connect_to_pool():
        return jsonify({'success': True, 'host_id': client.host_id})
    return jsonify({'success': False, 'error': 'Failed to connect'}), 500

@app.route('/api/disconnect', methods=['POST'])
def disconnect():
    """Disconnect from Andy API pool"""
    if client.disconnect_from_pool():
        return jsonify({'success': True})
    return jsonify({'success': False, 'error': 'Failed to disconnect'}), 500

@app.route('/api/config', methods=['GET', 'POST'])
def config():
    """Get or update configuration"""
    if request.method == 'POST':
        data = request.get_json()
        
        # Update configuration
        if 'andy_api_url' in data:
            client.config['andy_api_url'] = data['andy_api_url']
        if 'ollama_url' in data:
            client.config['ollama_url'] = data['ollama_url']
        if 'auto_connect' in data:
            client.config['auto_connect'] = bool(data['auto_connect'])
        if 'max_vram_gb' in data:
            client.config['max_vram_gb'] = max(0, float(data['max_vram_gb']))
        if 'report_interval' in data:
            client.config['report_interval'] = max(10, int(data['report_interval']))
        
        client.save_config()
        logger.info("Configuration updated")
        return jsonify({'success': True})
    
    return jsonify(client.config)

@app.route('/api/stats')
def api_stats():
    """Get current statistics"""
    return jsonify(asdict(client.stats))

@app.route('/api/status')
def status():
    """Get current connection status"""
    return jsonify({
        'is_connected': client.is_connected,
        'host_id': client.host_id,
        'running': client.running,
        'enabled_models': [name for name, model in client.models.items() if model.enabled]
    })

# Additional missing API endpoints

@app.route('/api/toggle_model', methods=['POST'])
def api_toggle_model():
    """Toggle model enabled state (alternative endpoint)"""
    data = request.get_json()
    model_name = data.get('model_name')
    
    if model_name in client.models:
        client.models[model_name].enabled = not client.models[model_name].enabled
        logger.info(f"Model {model_name} {'enabled' if client.models[model_name].enabled else 'disabled'}")
        return jsonify({'success': True, 'enabled': client.models[model_name].enabled})
    return jsonify({'success': False, 'error': 'Model not found'}), 404

@app.route('/api/update_model', methods=['POST'])
def api_update_model():
    """Update model configuration (alternative endpoint)"""
    data = request.get_json()
    model_name = data.get('model_name')
    
    if model_name not in client.models:
        return jsonify({'success': False, 'error': 'Model not found'}), 404
    
    model = client.models[model_name]
    
    # Update configurable fields
    if 'max_concurrent' in data:
        model.max_concurrent = max(1, min(10, int(data['max_concurrent'])))
    if 'context_length' in data:
        model.context_length = max(512, min(32768, int(data['context_length'])))
    if 'supports_embedding' in data:
        model.supports_embedding = bool(data['supports_embedding'])
    if 'supports_vision' in data:
        model.supports_vision = bool(data['supports_vision'])
    if 'supports_audio' in data:
        model.supports_audio = bool(data['supports_audio'])
    if 'enabled' in data:
        model.enabled = bool(data['enabled'])
    
    logger.info(f"Updated config for model {model_name}")
    return jsonify({'success': True})

@app.route('/api/save_config', methods=['POST'])
def api_save_config():
    """Save configuration (alternative endpoint)"""
    data = request.get_json()
    
    # Update configuration
    if 'andy_api_url' in data:
        client.config['andy_api_url'] = data['andy_api_url']
    if 'ollama_url' in data:
        client.config['ollama_url'] = data['ollama_url']
    if 'auto_connect' in data:
        client.config['auto_connect'] = bool(data['auto_connect'])
    if 'max_vram_gb' in data:
        client.config['max_vram_gb'] = max(0, float(data['max_vram_gb']))
    if 'report_interval' in data:
        client.config['report_interval'] = max(10, int(data['report_interval']))
    if 'client_name' in data:
        client.config['client_name'] = data['client_name']
    
    client.save_config()
    logger.info("Configuration saved")
    return jsonify({'success': True})

@app.route('/api/metrics_data')
def api_metrics_data():
    """Get metrics data for charts and monitoring"""
    hours = request.args.get('hours', '24', type=int)
    
    try:
        # Get request history from database
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        # Get recent requests
        cursor.execute('''
            SELECT timestamp, model_name, request_type, tokens, response_time, success
            FROM requests 
            WHERE timestamp > datetime('now', '-{} hours')
            ORDER BY timestamp DESC
        '''.format(hours))
        
        requests_data = cursor.fetchall()
        conn.close()
        
        # Calculate metrics
        total_requests = len(requests_data)
        successful_requests = sum(1 for r in requests_data if r[5])  # success column
        failed_requests = total_requests - successful_requests
        
        # Calculate average response time
        response_times = [r[4] for r in requests_data if r[4] > 0]  # response_time column
        avg_response_time = sum(response_times) / len(response_times) if response_times else 0
        
        # Get system info
        cpu_percent = 0
        memory_percent = 0
        memory_used_gb = 0
        memory_total_gb = 0
        disk_percent = 0
        disk_used_gb = 0
        disk_total_gb = 0
        
        if PSUTIL_AVAILABLE:
            cpu_percent = psutil.cpu_percent()
            memory = psutil.virtual_memory()
            disk = psutil.disk_usage('/')
            memory_percent = memory.percent
            memory_used_gb = memory.used / (1024**3)
            memory_total_gb = memory.total / (1024**3)
            disk_percent = (disk.used / disk.total) * 100
            disk_used_gb = disk.used / (1024**3)
            disk_total_gb = disk.total / (1024**3)
        
        # GPU info (basic, would need specific libraries for detailed info)
        gpu_info = "N/A"
        if GPUTIL_AVAILABLE:
            try:
                gpus = GPUtil.getGPUs()
                if gpus:
                    gpu = gpus[0]
                    gpu_info = f"{gpu.name} - {gpu.memoryUsed}MB/{gpu.memoryTotal}MB"
            except Exception:
                pass
        
        metrics = {
            'system_metrics': {
                'cpu_percent': cpu_percent,
                'memory_percent': memory_percent,
                'memory_used_gb': memory_used_gb,
                'memory_total_gb': memory_total_gb,
                'disk_percent': disk_percent,
                'disk_used_gb': disk_used_gb,
                'disk_total_gb': disk_total_gb,
                'gpu_info': gpu_info
            },
            'request_metrics': {
                'total_requests': total_requests,
                'successful_requests': successful_requests,
                'failed_requests': failed_requests,
                'success_rate': (successful_requests / total_requests * 100) if total_requests > 0 else 0,
                'avg_response_time': avg_response_time
            },
            'connection_status': {
                'is_connected': client.is_connected,
                'host_id': client.host_id,
                'enabled_models_count': sum(1 for model in client.models.values() if model.enabled),
                'total_models_count': len(client.models)
            },
            'uptime': {
                'start_time': client.stats.uptime_start.isoformat(),
                'uptime_seconds': (datetime.now() - client.stats.uptime_start).total_seconds()
            }
        }
        
        return jsonify(metrics)
        
    except Exception as e:
        logger.error(f"Error getting metrics data: {e}")
        # Return basic metrics even if database fails
        return jsonify({
            'system_metrics': {
                'cpu_percent': 0,
                'memory_percent': 0,
                'memory_used_gb': 0,
                'memory_total_gb': 0,
                'disk_percent': 0,
                'disk_used_gb': 0,
                'disk_total_gb': 0,
                'gpu_info': "N/A"
            },
            'request_metrics': {
                'total_requests': client.stats.total_requests,
                'successful_requests': client.stats.successful_requests,
                'failed_requests': client.stats.failed_requests,
                'success_rate': 0,
                'avg_response_time': 0
            },
            'connection_status': {
                'is_connected': client.is_connected,
                'host_id': client.host_id,
                'enabled_models_count': sum(1 for model in client.models.values() if model.enabled),
                'total_models_count': len(client.models)
            },
            'uptime': {
                'start_time': client.stats.uptime_start.isoformat(),
                'uptime_seconds': (datetime.now() - client.stats.uptime_start).total_seconds()
            }
        })

if __name__ == '__main__':
    # Start background threads
    client.start_background_threads()
    
    try:
        # Run Flask app
        app.run(host='0.0.0.0', port=5000, debug=False)
    finally:
        # Clean shutdown
        client.stop_background_threads()
        client.disconnect_from_pool()
