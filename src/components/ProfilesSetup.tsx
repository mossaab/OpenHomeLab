import React from 'react';
import { useState, useEffect } from 'react';
import { apiCall } from '../api';
import { Profile } from '../types';
import { Plus, Trash2, Pencil, KeyRound, X, AlertCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { useI18n } from '../i18n';
import ConfirmDialog from './ConfirmDialog';
import Modal from './Modal';

interface ProfilesSetupProps {
  embedded?: boolean;
}

export default function ProfilesSetup({ embedded = false }: ProfilesSetupProps) {
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    username: 'root',
    auth_type: 'password' as 'password' | 'key',
    password: '',
    private_key: '',
  });

  const fetchData = async () => {
    try {
      const profs = await apiCall('/profiles');
      setProfiles(profs);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const resetForm = () => {
    setFormData({
      name: '',
      username: 'root',
      auth_type: 'password',
      password: '',
      private_key: '',
    });
    setEditingProfile(null);
  };

  const openAddModal = () => {
    resetForm();
    setShowModal(true);
  };

  const openEditModal = (profile: Profile) => {
    setFormData({
      name: profile.name,
      username: profile.username,
      auth_type: profile.auth_type,
      password: '',
      private_key: '',
    });
    setEditingProfile(profile);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const body: any = {
      name: formData.name,
      username: formData.username,
      auth_type: formData.auth_type,
    };

    if (formData.auth_type === 'password') {
      body.password = formData.password;
    } else {
      body.private_key = formData.private_key;
    }

    try {
      if (editingProfile) {
        await apiCall(`/profiles/${editingProfile.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await apiCall('/profiles', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      closeModal();
      fetchData();
    } catch (e: any) {
      setError(t('profiles.saveFailed', { message: e.message }));
    }
  };

  const handleDelete = async (id: number) => {
    setDeleteId(id);
  };

  const confirmDelete = async () => {
    setDeleteId(null);
    try {
      await apiCall(`/profiles/${deleteId!}`, { method: 'DELETE' });
      fetchData();
    } catch (e: any) {
      setError(t('profiles.deleteFailed', { message: e.message }));
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between gap-4">
        {!embedded && (
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">{t('profiles.title')}</h2>
            <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">{t('profiles.subtitle')}</p>
          </div>
        )}
        <button
          onClick={openAddModal}
          className="ms-auto flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
        >
          <Plus size={18} />
          {t('profiles.addBtn')}
        </button>
      </div>

      {/* Modal */}
      {showModal && (
        <Modal
          onBackdropClick={closeModal}
          className="w-full sm:max-w-lg max-h-[92dvh] sm:max-h-[85vh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
        >
            <div className="flex items-center justify-between mb-6">
              <h3 className="font-medium text-slate-800 dark:text-slate-200 flex items-center gap-2">
                {editingProfile ? (
                  <>
                    <Pencil size={18} className="text-indigo-600 dark:text-indigo-400" /> {t('profiles.editTitle')}
                  </>
                ) : (
                  <>
                    <Plus size={18} className="text-indigo-600 dark:text-indigo-400" /> {t('profiles.createTitle')}
                  </>
                )}
              </h3>
              <button
                onClick={closeModal}
                className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-300 transition-colors p-1 rounded-lg hover:bg-slate-200/70 dark:hover:bg-white/10"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('profiles.name')}</label>
                  <input
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    placeholder={t('profiles.namePlaceholder')}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('profiles.username')}</label>
                  <input
                    required
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                    className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    placeholder={t('profiles.usernamePlaceholder')}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    {t('profiles.method')}
                  </label>
                  <select
                    value={formData.auth_type}
                    onChange={(e) => setFormData({ ...formData, auth_type: e.target.value as any })}
                    className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 [&>option]:bg-white dark:[&>option]:bg-slate-900"
                  >
                    <option value="password">{t('profiles.authPassword')}</option>
                    <option value="key">{t('profiles.authKey')}</option>
                  </select>
                </div>

                {formData.auth_type === 'password' ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      {t('profiles.password')} {editingProfile ? t('profiles.keepCurrentNote') : ''}
                    </label>
                    <input
                      type="password"
                      required={!editingProfile}
                      value={formData.password}
                      onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                      className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder={editingProfile ? t('profiles.keepCurrentPlaceholder') : t('profiles.authPassword')}
                    />
                  </div>
                ) : (
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      {t('profiles.privateKey')} {editingProfile ? t('profiles.keepCurrentNote') : ''}
                    </label>
                    <textarea
                      required={!editingProfile}
                      rows={4}
                      value={formData.private_key}
                      onChange={(e) => setFormData({ ...formData, private_key: e.target.value })}
                      className="w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono text-xs"
                      placeholder={
                        editingProfile
                          ? t('profiles.keepCurrentPlaceholder')
                          : '-----BEGIN RSA PRIVATE KEY-----...'
                      }
                    />
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 -mx-6 flex gap-3 border-t border-slate-200 dark:border-white/10 bg-white/95 px-6 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] backdrop-blur-md dark:bg-slate-900/95">
                <button
                  type="submit"
                  className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
                >
                  {editingProfile ? t('profiles.saveChangesBtn') : t('profiles.saveProfileBtn')}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
                >
                  {t('common.cancel')}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {/* Profile cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {profiles.map((profile, i) => (
          <motion.div
            key={profile.id}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.05 }}
            className="glass-card rounded-2xl p-6 flex flex-col items-start gap-4"
          >
            <div className="w-full flex justify-between items-start">
              <div className="flex items-center gap-3 text-slate-800 dark:text-slate-200 font-medium">
                <div className="p-2 glass border border-slate-200 dark:border-white/10 text-indigo-600 dark:text-indigo-400 rounded-lg">
                  <KeyRound size={20} />
                </div>
                {profile.name}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => openEditModal(profile)}
                  className="text-slate-500 hover:text-indigo-600 dark:text-indigo-400 transition-colors p-1.5 glass hover:bg-indigo-500/20 rounded-lg"
                  title={t('profiles.editTitle')}
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => handleDelete(profile.id)}
                  className="text-slate-500 hover:text-rose-600 dark:text-rose-400 transition-colors p-1.5 glass hover:bg-rose-500/20 rounded-lg"
                  title={t('profiles.deleteTitle')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div className="space-y-1 w-full text-sm">
              <div className="flex flex-col border-b border-slate-200 dark:border-white/10 pb-2.5">
                <span className="text-slate-500 mb-1 text-xs">{t('profiles.usernameLabel')}</span>
                <span className="text-slate-700 dark:text-slate-300 font-mono break-all">{profile.username}</span>
              </div>
              <div className="flex flex-col pt-2.5">
                <span className="text-slate-500 mb-1 text-xs">{t('profiles.authMethodLabel')}</span>
                <span className="text-slate-700 dark:text-slate-300 capitalize">{profile.auth_type}</span>
              </div>
            </div>
          </motion.div>
        ))}
        {profiles.length === 0 && !loading && (
          <div className="sm:col-span-2 lg:col-span-3 text-center py-12 glass rounded-2xl border border-dashed border-slate-300 dark:border-white/20 text-slate-500 dark:text-slate-400">
            <p>{t('profiles.emptyHint')}</p>
          </div>
        )}
      </div>

      {deleteId && (
        <ConfirmDialog
          title={t('profiles.deleteTitle')}
          message={t('profiles.deleteMessage')}
          confirmLabel={t('common.delete')}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}

      {error && (
        <Modal
          onBackdropClick={() => setError(null)}
          className="w-full sm:max-w-sm max-h-[92dvh] overflow-y-auto custom-scrollbar rounded-t-2xl sm:rounded-2xl px-6 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-2xl border-b sm:border border-slate-200 dark:border-white/10"
        >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-rose-500/20 text-rose-600 dark:text-rose-400 rounded-lg">
                <AlertCircle size={20} />
              </div>
              <h3 className="font-medium text-slate-800 dark:text-slate-200">{t('profiles.errorTitle')}</h3>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">{error}</p>
            <button
              onClick={() => setError(null)}
              className="w-full bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
            >
              {t('common.close')}
            </button>
        </Modal>
      )}
    </div>
  );
}
