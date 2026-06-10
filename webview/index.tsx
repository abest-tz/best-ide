import { createRoot } from 'react-dom/client';
import { App } from './App';
import { styles } from './styles';

const styleElement = document.createElement('style');
styleElement.textContent = styles;
document.head.appendChild(styleElement);

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
