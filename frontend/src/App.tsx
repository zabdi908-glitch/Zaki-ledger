import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Upload from './pages/Upload';
import Review from './pages/Review';
import BatchReview from './pages/BatchReview';
import Reconcile from './pages/Reconcile';
import Settings from './pages/Settings';
import Toast from './components/Toast';

function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="upload" element={<Upload />} />
          <Route path="review" element={<Review />} />
          <Route path="batch" element={<BatchReview />} />
          <Route path="reconcile" element={<Reconcile />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
      <Toast />
    </>
  );
}

export default App;
